/**
 * The staging deploy's verification refresh, after the seeding step: `PUT
 * /api/demo/verification/{workspaceId}` copies every demo template the deploy just seeded into the
 * real-model verification workspace, so R1 (`../live-verify/`), dispatched on `main` after this
 * deploy, finds each seeded entry's agent there, a coming-soon entry's too (the Agent Store
 * 100-use-case plan, section 7).
 *
 *   STORE_PLATFORM_URL=<the deployment's control plane origin> \
 *   STORE_OPERATOR_TOKEN=<AW_DEMO_OPERATOR_TOKEN> \
 *   STORE_VERIFICATION_WORKSPACE_ID=<the verification workspace id> \
 *   node tests/store/seed/verification.ts
 *
 * It prints the entries copied, and fails when a staging-seeded entry is not among them or the
 * platform refuses; never the token, the address or a body. A fill brings a copy the workspace
 * already holds (the platform finds it by its agent's name) to the template as seeded now: its
 * instructions, permissions, assignments, skills, stand-ins and sample files (ADR-0171), so a
 * refill after a deploy is enough for a changed entry, a staged rebuild (`next`, ADR-0174)
 * included. Exits 0 when filled, 1 when not, 2 without settings.
 */
import { isUuid } from '@indx-workspace/contracts';
import { DemoVerificationFillSchema } from '@indx-workspace/contracts/demo-operator';

import { seededEntries } from './build.ts';
import { problemOf, readSettings as readOperatorSettings, type OperatorSettings } from './run.ts';

/** A fill copies every template, one after another; it is given far longer than one seed. */
const REQUEST_TIMEOUT_MS = 600_000;

interface FillSettings extends OperatorSettings {
  readonly workspaceId: string;
}

/** The settings from the environment, or why there are none; the reason names the variable only. */
export function readFillSettings(
  env: Readonly<Record<string, string | undefined>>,
): FillSettings | { readonly missing: string } {
  const operator = readOperatorSettings({ ...env, STORE_SEED_ENVIRONMENT: 'staging' });
  if ('missing' in operator) return operator;
  const workspaceId = env['STORE_VERIFICATION_WORKSPACE_ID']?.trim() ?? '';
  if (!isUuid(workspaceId)) {
    return { missing: 'STORE_VERIFICATION_WORKSPACE_ID' };
  }
  return { baseUrl: operator.baseUrl, token: operator.token, workspaceId };
}

/**
 * Fills the verification workspace and checks that every entry of `expected` was copied. The line
 * names the entries, which are catalog slugs and safe to print.
 */
export async function fillVerification(
  settings: FillSettings,
  expected: readonly string[],
  send: typeof fetch = fetch,
): Promise<{ readonly line: string; readonly ok: boolean }> {
  const response = await send(`${settings.baseUrl}/api/demo/verification/${settings.workspaceId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${settings.token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return { line: `verification workspace: refused ${await problemOf(response)}`, ok: false };
  }
  const answer = DemoVerificationFillSchema.safeParse(await response.json());
  if (!answer.success) {
    return { line: 'verification workspace: the answer is not readable', ok: false };
  }
  const missing = expected.filter((entry) => !answer.data.entries.includes(entry));
  const copied = `copied ${answer.data.entries.join(', ')}`;
  return missing.length === 0
    ? { line: `verification workspace: ${copied}`, ok: true }
    : { line: `verification workspace: ${copied}; not copied ${missing.join(', ')}`, ok: false };
}

async function main(): Promise<number> {
  const settings = readFillSettings(process.env);
  if ('missing' in settings) {
    console.error(`${settings.missing} is not set to a valid value.`);
    return 2;
  }
  try {
    const expected = seededEntries('staging').map((entry) => entry.slug);
    const result = await fillVerification(settings, expected);
    console.log(result.line);
    return result.ok ? 0 : 1;
  } catch {
    // A failed request has no safe text to print: it may name the address.
    console.log('verification workspace: failed');
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
