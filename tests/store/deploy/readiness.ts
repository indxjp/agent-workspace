/**
 * The second read-only Anthropic key check of a store deployment (R2): asks the platform whether
 * its demo key is configured and reaches the Anthropic API.
 *
 *   STORE_PLATFORM_URL=<platform origin> STORE_OPERATOR_TOKEN=<token> node tests/store/deploy/readiness.ts
 *
 * It prints the two booleans and exits 0 only when both are true. It never prints the operator
 * token, never follows a redirect (the bearer would go with it) and the answer carries no key.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DemoReadinessSchema } from '@indx-workspace/contracts/demo-operator';

const TIMEOUT_MS = 30_000;

export interface ReadinessResult {
  readonly apiKeyConfigured: boolean;
  readonly apiReachable: boolean;
}

/** What the check refuses with: a message that never holds the token. */
export class ReadinessRefusal extends Error {}

export async function checkReadiness(
  env: Readonly<Record<string, string | undefined>>,
  fetcher: typeof fetch = fetch,
): Promise<ReadinessResult> {
  const platform = env['STORE_PLATFORM_URL']?.trim() ?? '';
  const token = env['STORE_OPERATOR_TOKEN']?.trim() ?? '';
  if (platform === '') throw new ReadinessRefusal('STORE_PLATFORM_URL is not set');
  if (token === '') throw new ReadinessRefusal('STORE_OPERATOR_TOKEN is not set');
  let url: URL;
  try {
    url = new URL('/api/demo/readiness', platform);
  } catch {
    throw new ReadinessRefusal('STORE_PLATFORM_URL is not a URL');
  }
  if (url.protocol !== 'https:') throw new ReadinessRefusal('STORE_PLATFORM_URL must be https');
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ReadinessRefusal('the platform could not be reached');
  }
  if (!response.ok) {
    throw new ReadinessRefusal(`the readiness route answered ${String(response.status)}`);
  }
  const parsed = DemoReadinessSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new ReadinessRefusal('the readiness answer is not the expected shape');
  return parsed.data;
}

async function main(): Promise<number> {
  try {
    const result = await checkReadiness(process.env);
    console.log(`apiKeyConfigured: ${String(result.apiKeyConfigured)}`);
    console.log(`apiReachable: ${String(result.apiReachable)}`);
    return result.apiKeyConfigured && result.apiReachable ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'the readiness check failed');
    return 2;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}
