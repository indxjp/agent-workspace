/**
 * Application Default Credentials helpers for `cloud-run.ts`. Split out so the driver module
 * itself only needs `fetch` and stays testable with a fake `CloudRunResourceClient` — nothing in
 * `cloud-run.test.ts` touches this file, and nothing here is exercised outside a real GCP identity
 * (metadata server on Cloud Run, `gcloud auth application-default login` locally).
 */
import type { GoogleAuth } from 'google-auth-library';

let sharedAuth: Promise<GoogleAuth> | undefined;

/** Loaded on first use: the SDK is optional, and a runtime that never selects Cloud Run lacks it. */
function auth(): Promise<GoogleAuth> {
  sharedAuth ??= import('google-auth-library').then(
    ({ GoogleAuth }) =>
      new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }),
  );
  return sharedAuth;
}

/** Bearer token for calling the Cloud Run Admin API (create/get/delete a per-session service). */
export async function fetchCloudRunAccessToken(): Promise<string> {
  const client = await (await auth()).getClient();
  const response = await client.getAccessToken();
  if (typeof response.token !== 'string' || response.token.length === 0) {
    throw new Error('cloud-run runtime: application default credentials returned no access token.');
  }
  return response.token;
}

/**
 * Google-signed identity token scoped to one private Cloud Run service URL. This is what proves to
 * that service's IAM invoker check that the runner manager, not an arbitrary caller, is making the
 * request — the manager's own bearer token never leaves the control plane, so the runtime container
 * cannot be handed it and replay it elsewhere.
 */
export async function fetchCloudRunIdentityToken(audience: string): Promise<string> {
  const client = await (await auth()).getIdTokenClient(audience);
  const headers = await client.getRequestHeaders();
  const authorization = headers.get('Authorization') ?? headers.get('authorization');
  const match = authorization === null ? null : /^Bearer\s+(.+)$/u.exec(authorization);
  if (match === null) {
    throw new Error(`cloud-run runtime: no identity token available for audience ${audience}.`);
  }
  return match[1] ?? '';
}
