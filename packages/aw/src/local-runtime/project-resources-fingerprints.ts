import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SecretNameSchema } from '@indx-workspace/contracts/secret-reference';
import { type PlanSecret } from '@indx-workspace/sdk/project';
import { z } from 'zod';
import { nonBlank } from '../config.js';
import { writeOwnerOnlyJsonFile } from '../credentials.js';
import type { CliIo } from '../io.js';

/** The runtime's own directory (gitignored by the runtime), where SD16's fingerprints are kept. */
export const FINGERPRINTS_FILE = path.join('.agent-workspace', 'secret-fingerprints.json');

const FingerprintsFileSchema = z
  .object({
    /** The HMAC key, 32 random bytes in base64: a fingerprint says nothing without it. */
    key: z.base64().length(44),
    fingerprints: z.record(SecretNameSchema, z.string().regex(/^[0-9a-f]{64}$/u)),
    /** Issue #732: the `ANTHROPIC_BASE_URL` the C6 `default` connection last took; `null`, unset. */
    anthropicBaseUrl: z.string().nullable().optional(),
  })
  .strict();

export interface Fingerprints {
  readonly key: Buffer;
  readonly fingerprints: Record<string, string>;
  anthropicBaseUrl?: string | null;
}

/** The recorded fingerprints; a missing or malformed file is "nothing recorded", so all rotate. */
export async function readFingerprints(file: string): Promise<Fingerprints> {
  try {
    const parsed = FingerprintsFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    return {
      key: Buffer.from(parsed.key, 'base64'),
      fingerprints: parsed.fingerprints,
      ...(parsed.anthropicBaseUrl === undefined
        ? {}
        : { anthropicBaseUrl: parsed.anthropicBaseUrl }),
    };
  } catch {
    return { key: randomBytes(32), fingerprints: {} };
  }
}

function fingerprintOf(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

/** The value and SD16 state of each named secret `aw dev`'s environment sets; unset ones are absent. */
export function secretInputs(
  names: readonly string[],
  env: CliIo['env'],
  recorded: Fingerprints,
): { readonly values: Map<string, string>; readonly secrets: Map<string, PlanSecret> } {
  const values = new Map<string, string>();
  const secrets = new Map<string, PlanSecret>();
  for (const name of names) {
    const value = nonBlank(env[name]);
    if (value === undefined) continue;
    values.set(name, value);
    const sentFingerprint = recorded.fingerprints[name];
    secrets.set(name, {
      fingerprint: fingerprintOf(recorded.key, value),
      ...(sentFingerprint === undefined ? {} : { sentFingerprint }),
    });
  }
  return { values, secrets };
}

interface SecretDelivery {
  readonly sentSecrets: ReadonlySet<string>;
  readonly failedSecrets: ReadonlySet<string>;
}

/**
 * SD16: record a secret's fingerprint only when every action naming it succeeded, and forget it
 * when one failed, so a refused or interrupted send is retried next time. Writes only on a change.
 */
export async function recordFingerprints(
  record: { readonly file: string; readonly recorded: Fingerprints },
  secrets: ReadonlyMap<string, PlanSecret>,
  delivery: SecretDelivery,
  /** The `ANTHROPIC_BASE_URL` the `default` connection now holds; `undefined` leaves the record. */
  anthropicBaseUrl: string | null | undefined,
): Promise<void> {
  const { file, recorded } = record;
  const { sentSecrets, failedSecrets } = delivery;
  let changed = false;
  if (anthropicBaseUrl !== undefined && anthropicBaseUrl !== recorded.anthropicBaseUrl) {
    recorded.anthropicBaseUrl = anthropicBaseUrl;
    changed = true;
  }
  for (const secret of failedSecrets) {
    changed ||= secret in recorded.fingerprints;
    delete recorded.fingerprints[secret];
  }
  for (const secret of sentSecrets) {
    const sent = secrets.get(secret);
    if (failedSecrets.has(secret) || sent === undefined) continue;
    recorded.fingerprints[secret] = sent.fingerprint;
    changed = true;
  }
  if (changed) {
    await writeOwnerOnlyJsonFile(file, {
      key: recorded.key.toString('base64'),
      fingerprints: recorded.fingerprints,
      ...(recorded.anthropicBaseUrl === undefined
        ? {}
        : { anthropicBaseUrl: recorded.anthropicBaseUrl }),
    });
  }
}
