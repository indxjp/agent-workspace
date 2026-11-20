/** Whether the Secret Manager secrets the web app reads exist and hold an enabled version. */
import { z } from 'zod';

import { bearerHeaders, check, type GcpPreflightCheck } from './gcp-preflight-check.ts';

/**
 * Whether a secret version's metadata says it is ENABLED: Cloud Run cannot start a revision on a
 * DISABLED or DESTROYED latest version. A body that is not the expected shape counts as not enabled.
 */
async function isEnabledVersion(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.json();
    return z.object({ state: z.string() }).safeParse(body).data?.state === 'ENABLED';
  } catch {
    return false;
  }
}

/** The command a person runs to store a missing secret; the value is typed there, never given to this tool. */
function storeSecretCommand(secret: string, project: string): string {
  return (
    `${secret}: if it does not exist, create it (gcloud secrets create ${secret} --project ${project} --replication-policy=automatic), ` +
    `then add an enabled version (gcloud secrets versions add ${secret} --project ${project} --data-file=-)`
  );
}

/** The secrets without an enabled latest version, or `undefined` when an answer says nothing. */
async function missingSecrets(
  fetchImpl: typeof fetch,
  project: string,
  token: string,
  secrets: readonly string[],
): Promise<readonly string[] | undefined> {
  const missing: string[] = [];
  for (const secret of secrets) {
    try {
      const response = await fetchImpl(
        `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${secret}/versions/latest`,
        { method: 'GET', headers: bearerHeaders(token, false) },
      );
      if (response.status === 404) missing.push(secret);
      else if (!response.ok) return undefined;
      else if (!(await isEnabledVersion(response))) missing.push(secret);
    } catch {
      return undefined;
    }
  }
  return missing;
}

/**
 * That every secret `gcp.secretSettings` names exists in the project and holds an enabled latest version,
 * from its metadata only: the payload is never requested, so no value is read, sent or printed. A
 * missing one fails with the `gcloud` commands a person runs to store it; an answer that says
 * nothing (no token, a refusal, a network failure) is a warning, because the deployer may lack
 * `secretmanager.versions.get`.
 */
export async function checkWebSecrets(
  fetchImpl: typeof fetch,
  project: string,
  token: string | undefined,
  secrets: readonly string[],
): Promise<GcpPreflightCheck> {
  const names = secrets.join(', ');
  const unknown = check('web-secrets', `Could not check the web secrets (${names})`, 'warn');
  if (token === undefined) return unknown;
  const missing = await missingSecrets(fetchImpl, project, token, secrets);
  if (missing === undefined) return unknown;
  if (missing.length === 0) {
    return check(
      'web-secrets',
      `Every web secret (${names}) holds an enabled latest version`,
      'ok',
    );
  }
  return check(
    'web-secrets',
    `The web secret(s) ${missing.join(', ')} are missing or hold no enabled latest version`,
    'fail',
    missing.map((secret) => storeSecretCommand(secret, project)).join('; '),
  );
}
