import { SETUP_PROVIDERS } from '@indx-workspace/contracts/setup';
import { NextResponse } from 'next/server';

import { admitSignInAttempt } from '../../../server/auth/sign-in-limit';
import { setupSecretsOf, setupStepFailure } from '../../../server/setup/failure';
import { applicationContext } from '../../../server/application-context';
import type { SetupInput, SetupResult } from '../../../server/setup/runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** A provider base URL setup will have the server call: https, and nothing that carries a credential. */
function providerBaseUrlOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const plain =
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '';
    return plain ? value : null;
  } catch {
    return null;
  }
}

/** A runtime key is sent as an HTTP header value, so only visible ASCII can be one. */
const RUNTIME_CREDENTIAL = /^[\x21-\x7e]+$/u;

/** The optional runtime key and endpoint: both or neither, `null` when either is malformed. */
function runtimeConnectionOf(
  row: Record<string, unknown>,
): Pick<SetupInput, 'runtimeCredential' | 'runtimeEndpoint'> | null {
  const credential = row['runtimeCredential'];
  const endpoint = row['runtimeEndpoint'];
  if (credential === undefined && endpoint === undefined) return {};
  if (typeof credential !== 'string' || !RUNTIME_CREDENTIAL.test(credential)) return null;
  const runtimeEndpoint = providerBaseUrlOf(endpoint);
  if (runtimeEndpoint === null) return null;
  return { runtimeCredential: credential, runtimeEndpoint };
}

function inputOf(value: unknown): SetupInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const provider = row['provider'];
  const setupProvider = SETUP_PROVIDERS.find((candidate) => candidate === provider);
  if (setupProvider === undefined) return null;
  const names = [
    'providerApiKey',
    'runtime',
    'adminEmail',
    'adminPassword',
    'agentName',
    'agentInstructions',
  ] as const;
  if (names.some((name) => typeof row[name] !== 'string')) return null;
  const providerBaseUrl =
    row['providerBaseUrl'] === undefined ? '' : providerBaseUrlOf(row['providerBaseUrl']);
  if (providerBaseUrl === null) return null;
  const runtimeConnection = runtimeConnectionOf(row);
  if (runtimeConnection === null) return null;
  return {
    provider: setupProvider,
    providerApiKey: row['providerApiKey'] as string,
    runtime: row['runtime'] as string,
    adminEmail: row['adminEmail'] as string,
    adminPassword: row['adminPassword'] as string,
    agentName: row['agentName'] as string,
    agentInstructions: row['agentInstructions'] as string,
    ...(providerBaseUrl === '' ? {} : { providerBaseUrl }),
    ...runtimeConnection,
  };
}

/**
 * A refusal in the one standard envelope every `/api/**` route answers with (`ApiProblemSchema`,
 * issue #238). The setup wizard reads `error.message`.
 */
function refuse(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const setup = applicationContext()?.setup;
  if (setup?.kind !== 'serving') {
    return refuse(503, 'setup_unavailable', 'Setup persistence is not configured.');
  }
  const { runtime } = setup;
  // Setup checks the bootstrap administrator's password, so it shares sign-in's attempt budget.
  const admission = admitSignInAttempt(request.headers);
  if (!admission.admitted) {
    const response = refuse(429, 'rate_limited', 'Too many attempts. Try again shortly.');
    response.headers.set('retry-after', String(admission.retryAfterSeconds));
    return response;
  }
  const input = inputOf(await request.json().catch(() => null));
  if (input === null) {
    return refuse(400, 'invalid_setup', 'Every setup field is required.');
  }
  let result: SetupResult;
  try {
    result = await runtime.complete(input);
  } catch (error) {
    // A throw would reach the client as Next's empty 500.
    result = setupStepFailure('setup', error, setupSecretsOf(input));
  }
  if (!result.ok) {
    return refuse(result.status, result.code, result.message);
  }
  const response = NextResponse.json(
    {
      agentId: result.agentId,
      modelConnectionId: result.modelConnectionId,
      runtimeProfileId: result.runtimeProfileId,
      runtimeConnectionId: result.runtimeConnectionId,
      runtimeRefusal: result.runtimeRefusal ?? null,
    },
    { status: 201 },
  );
  const { name, value, ...options } = result.cookie;
  response.cookies.set(name, value, options);
  return response;
}
