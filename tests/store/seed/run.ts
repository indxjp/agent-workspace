/**
 * The deploy's template seeding step: `PUT /api/demo/templates/{entry}` for every entry the
 * environment seeds (`seededEntries`: in staging every entry with a source, live or coming soon; in
 * production the live ones), with the entry's agent, connectors, sample files and sample records
 * (`build.ts`), so a visitor's demo, and in staging the real-model verification, has a template to
 * copy.
 *
 *   STORE_PLATFORM_URL=<the deployment's control plane origin> \
 *   STORE_OPERATOR_TOKEN=<AW_DEMO_OPERATOR_TOKEN> \
 *   STORE_SEED_ENVIRONMENT=staging|production \
 *   node tests/store/seed/run.ts
 *
 * Idempotent: an entry whose seed is already in place answers `changed: false`. It prints each entry
 * and whether it changed, and on a refusal the platform's problem code; never the token, the
 * address or a body. Exits 0 when every entry is in place, 1 when one failed, 2 without the settings.
 */
import { buildSeed, seededEntries, type SeedEnvironment } from './build.ts';

const REQUEST_TIMEOUT_MS = 120_000;

/** The platform and the operator token every operator call of the deploy sends. */
export interface OperatorSettings {
  readonly baseUrl: string;
  readonly token: string;
}

interface Settings extends OperatorSettings {
  readonly environment: SeedEnvironment;
}

/** The settings from the environment, or why there are none; the reason names the variable only. */
export function readSettings(
  env: Readonly<Record<string, string | undefined>>,
): Settings | { readonly missing: string } {
  const baseUrl = env['STORE_PLATFORM_URL']?.trim() ?? '';
  const token = env['STORE_OPERATOR_TOKEN']?.trim() ?? '';
  const environment = env['STORE_SEED_ENVIRONMENT']?.trim();
  if (baseUrl === '') return { missing: 'STORE_PLATFORM_URL' };
  if (token === '') return { missing: 'STORE_OPERATOR_TOKEN' };
  if (environment !== 'staging' && environment !== 'production') {
    return { missing: 'STORE_SEED_ENVIRONMENT' };
  }
  return { baseUrl: baseUrl.replace(/\/+$/u, ''), token, environment };
}

/** `entry: changed` or `entry: unchanged`, or `entry: refused <code>`; never a body. */
export async function seedEntry(
  settings: OperatorSettings,
  entry: string,
  body: unknown,
  send: typeof fetch = fetch,
): Promise<{ readonly line: string; readonly ok: boolean }> {
  const response = await send(`${settings.baseUrl}/api/demo/templates/${entry}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.ok) {
    const answer = (await response.json()) as { changed?: unknown };
    return { line: `${entry}: ${answer.changed === true ? 'changed' : 'unchanged'}`, ok: true };
  }
  return { line: `${entry}: refused ${await problemOf(response)}`, ok: false };
}

/** A refusal as `<status> <problem code>`, `unknown` when its body names none; never the body. */
export async function problemOf(response: Response): Promise<string> {
  let code = 'unknown';
  try {
    const problem = (await response.json()) as { error?: { code?: unknown } };
    if (typeof problem.error?.code === 'string') code = problem.error.code;
  } catch {
    // An answer with no JSON body has only its status.
  }
  return `${String(response.status)} ${code}`;
}

async function main(): Promise<number> {
  const settings = readSettings(process.env);
  if ('missing' in settings) {
    console.error(`${settings.missing} is not set to a valid value.`);
    return 2;
  }
  let failed = false;
  for (const entry of seededEntries(settings.environment)) {
    try {
      const result = await seedEntry(settings, entry.slug, buildSeed(entry));
      console.log(`${result.line}${entry.status === 'soon' ? ' (coming soon)' : ''}`);
      failed ||= !result.ok;
    } catch {
      // A failed request has no safe text to print: it may name the address.
      console.log(`${entry.slug}: failed`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
