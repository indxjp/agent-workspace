/**
 * The deploy's template seeding step: `PUT /api/demo/templates/{entry}` for every live catalog entry
 * (the entry's agent, connectors, sample files and sample records, `build.ts`), so a visitor's demo
 * has a template to copy.
 *
 *   STORE_PLATFORM_URL=<the deployment's control plane origin> \
 *   STORE_OPERATOR_TOKEN=<AW_DEMO_OPERATOR_TOKEN> \
 *   node tests/store/seed/run.ts
 *
 * Idempotent: an entry whose seed is already in place answers `changed: false`. It prints each entry
 * and whether it changed, and on a refusal the platform's problem code; never the token, the
 * address or a body. Exits 0 when every entry is in place, 1 when one failed, 2 without the settings.
 */
import { buildSeed, liveEntries } from './build.ts';

const REQUEST_TIMEOUT_MS = 120_000;

interface Settings {
  readonly baseUrl: string;
  readonly token: string;
}

/** The settings from the environment, or why there are none; the reason names the variable only. */
export function readSettings(
  env: Readonly<Record<string, string | undefined>>,
): Settings | { readonly missing: string } {
  const baseUrl = env['STORE_PLATFORM_URL']?.trim() ?? '';
  const token = env['STORE_OPERATOR_TOKEN']?.trim() ?? '';
  if (baseUrl === '') return { missing: 'STORE_PLATFORM_URL' };
  if (token === '') return { missing: 'STORE_OPERATOR_TOKEN' };
  return { baseUrl: baseUrl.replace(/\/+$/u, ''), token };
}

/** `entry: changed` or `entry: unchanged`, or `entry: refused <code>`; never a body. */
export async function seedEntry(
  settings: Settings,
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
  let code = 'unknown';
  try {
    const problem = (await response.json()) as { error?: { code?: unknown } };
    if (typeof problem.error?.code === 'string') code = problem.error.code;
  } catch {
    // An answer with no JSON body has only its status.
  }
  return { line: `${entry}: refused ${String(response.status)} ${code}`, ok: false };
}

async function main(): Promise<number> {
  const settings = readSettings(process.env);
  if ('missing' in settings) {
    console.error(`${settings.missing} is not set.`);
    return 2;
  }
  let failed = false;
  for (const entry of liveEntries()) {
    try {
      const result = await seedEntry(settings, entry.slug, buildSeed(entry));
      console.log(result.line);
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
