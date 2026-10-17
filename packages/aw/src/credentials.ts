import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CLI_TOKEN_PATTERN } from '@indx-workspace/contracts/cli-auth';
import { IsoDateTimeSchema } from '@indx-workspace/contracts';
import { z } from 'zod';

import { UsageError } from './io.js';

/**
 * `~/.config/agent-workspace/credentials.json` — issue #242 (SDK-10, S-22): the user token
 * `aw login` obtained, one per control plane URL. ADR-0083.
 *
 * The token is a bearer credential with a person's reach, so it is handled with more care than
 * `profiles.json`, which holds only the name of an environment variable:
 *
 *   * the file is created owner-only (`0600`) in an owner-only directory (`0700`), written to a
 *     temporary sibling and renamed into place so no reader sees a half-written file, and its mode
 *     is re-asserted after every write;
 *   * the token never comes from a flag, never reaches stdout, stderr or `--json`, and nothing
 *     here logs.
 */
const StoredCredentialSchema = z
  .object({
    token: z.string().regex(CLI_TOKEN_PATTERN),
    expiresAt: IsoDateTimeSchema,
    workspaceId: z.string().min(1),
    workspaceSlug: z.string().min(1),
  })
  .strict()
  .readonly();

const CredentialsFileSchema = z.record(z.string().min(1), StoredCredentialSchema);

export type StoredCredential = z.infer<typeof StoredCredentialSchema>;
type CredentialsFile = z.infer<typeof CredentialsFileSchema>;

export function credentialsFilePath(homeDir: string): string {
  return path.join(homeDir, '.config', 'agent-workspace', 'credentials.json');
}

/** The key a credential is stored under: the control plane's origin and path, no trailing slash. */
export function urlKey(url: string): string {
  return url.replace(/\/+$/u, '');
}

export function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function readCredentialsFile(homeDir: string): Promise<CredentialsFile> {
  const filePath = credentialsFilePath(homeDir);
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw new UsageError(`could not read ${filePath}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UsageError(`${filePath} is not JSON; run \`aw logout\` or delete it`);
  }
  const parsed = CredentialsFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new UsageError(`${filePath} is malformed; run \`aw logout\` or delete it`);
  }
  return parsed.data;
}

async function writeCredentialsFile(homeDir: string, file: CredentialsFile): Promise<void> {
  await writeOwnerOnlyJsonFile(credentialsFilePath(homeDir), file);
}

/**
 * Write `file` as JSON to `filePath`, owner-only, atomically; an empty object removes the file.
 * Shared with the local runtime's key file (`local-runtime/local-credentials.ts`).
 */
export async function writeOwnerOnlyJsonFile(
  filePath: string,
  file: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (Object.keys(file).length === 0) {
    await rm(filePath, { force: true });
    return;
  }
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // `mkdir`'s mode applies only to a directory it creates. `~/.config/agent-workspace/` usually
  // exists already (`profiles.json` lives there), often `0755`, so tighten it every time. On
  // Windows `chmod` only toggles read-only, which is harmless here.
  await chmod(directory, 0o700);
  const temporary = `${filePath}.${String(process.pid)}.tmp`;
  // `wx` refuses to follow a planted symlink or reuse a stale file at the predictable name, so the
  // secret is only ever written into a file this call created with `0600`.
  await rm(temporary, { force: true });
  await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
  } catch (error) {
    // A failed rename (a locked target on Windows) must not leave the secret in a stray file.
    await rm(temporary, { force: true });
    throw error;
  }
  await chmod(filePath, 0o600);
}

/** The stored credential for `url`, or `null` when there is none or it has expired. */
export async function readStoredCredential(
  homeDir: string,
  url: string,
  now: Date = new Date(),
): Promise<StoredCredential | null> {
  const stored = (await readCredentialsFile(homeDir))[urlKey(url)];
  if (stored === undefined) return null;
  return Date.parse(stored.expiresAt) > now.getTime() ? stored : null;
}

/** Store (or replace) the credential for `url`. */
export async function saveStoredCredential(
  homeDir: string,
  url: string,
  credential: StoredCredential,
): Promise<void> {
  const file = await readCredentialsFile(homeDir);
  await writeCredentialsFile(homeDir, { ...file, [urlKey(url)]: credential });
}

/** Forget the credential for `url`. `false` when there was none. */
export async function removeStoredCredential(homeDir: string, url: string): Promise<boolean> {
  const file = await readCredentialsFile(homeDir);
  const key = urlKey(url);
  if (!(key in file)) return false;
  const remaining = Object.fromEntries(Object.entries(file).filter(([name]) => name !== key));
  await writeCredentialsFile(homeDir, remaining);
  return true;
}
