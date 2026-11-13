// POST /api/browser-token: a short-lived browser token for one run or session of the signed-in
// person, minted as that person (never with the app's API key) for this portal's own pages.
import { MintTokenRequestSchema } from '@indx-workspace/contracts/tokens';
import {
  AppServerError,
  appRuntime,
  currentPerson,
  personAuthOf,
  problem,
} from '@indx-workspace/app/server';
import { ApiProblemError, createClient } from '@indx-workspace/sdk';

/** The largest body read: a scope and a TTL are far smaller. */
const MAX_BODY_BYTES = 4096;

/** Whether `request` is from a signed-in person; the app's own refusal when that cannot be told. */
async function signedIn(request: Request): Promise<boolean | Response> {
  try {
    return (await currentPerson(request)) !== null;
  } catch (error) {
    if (error instanceof AppServerError) return problem(error.code, error.status, error.message);
    throw error;
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = personAuthOf(request);
  const person = auth === undefined ? false : await signedIn(request);
  if (person instanceof Response) return person;
  if (auth === undefined || !person) {
    return problem('unauthenticated', 401, 'Sign in to the portal first.');
  }
  const text = await request.text();
  let body: unknown;
  try {
    body = text.length > MAX_BODY_BYTES ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  const parsed = MintTokenRequestSchema.safeParse(body);
  if (!parsed.success) {
    return problem(
      'invalid_body',
      400,
      'Send { "scope": { "kind": "run" | "session", "id": "<uuid>" } }.',
      parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)'),
    );
  }
  const client = createClient({ baseUrl: appRuntime().awUrl, auth });
  try {
    const minted = await client.tokens.mint(
      parsed.data.scope,
      parsed.data.ttlSeconds === undefined ? {} : { ttlSeconds: parsed.data.ttlSeconds },
    );
    return Response.json(
      { token: minted.token, scope: minted.scope, expiresAt: minted.expiresAt },
      { status: 201, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof ApiProblemError && (error.status === 401 || error.status === 403)) {
      return problem('forbidden', 403, 'Agent Workspace does not mint this token for your sign-in.');
    }
    return problem(
      'upstream_failure',
      502,
      'Agent Workspace did not answer as expected. Try again later.',
    );
  }
}
