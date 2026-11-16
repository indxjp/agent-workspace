import { appRuntime, currentPerson, personAuthOf } from '@indx-workspace/app/server';
import { ApiProblemError, createClient, type AgentWorkspaceClient } from '@indx-workspace/sdk';
import { headers } from 'next/headers';

/**
 * Agent Workspace as the signed-in person: a client holding the person's own token from the
 * app's cookie, never the app's API key, so the platform answers with what that person may see.
 * `null` when nobody is signed in.
 */
export async function personClient(): Promise<AgentWorkspaceClient | null> {
  const request = new Request('http://portal.invalid/', {
    headers: { cookie: (await headers()).get('cookie') ?? '' },
  });
  const auth = personAuthOf(request);
  if (auth === undefined || (await currentPerson(request)) === null) return null;
  return createClient({ baseUrl: appRuntime().awUrl, auth });
}

/** A platform answer a page shows: the value, or why there is none. */
export type Answer<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'not-available' }
  | { readonly kind: 'failed' };

/**
 * `call`'s answer. A `401` or `403` is `not-available`: the platform does not serve this call to
 * the person's sign-in. Anything else that fails is `failed`.
 */
export async function answer<T>(call: () => Promise<T>): Promise<Answer<T>> {
  try {
    return { kind: 'ok', value: await call() };
  } catch (error) {
    if (error instanceof ApiProblemError && (error.status === 401 || error.status === 403)) {
      return { kind: 'not-available' };
    }
    return { kind: 'failed' };
  }
}
