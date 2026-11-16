import { createHash } from 'node:crypto';
import type { OidcSecretInput } from './gcp-lifecycle.ts';
import { applyFoundation } from './gcp-staged-apply.ts';
import { runStep, type DeployContext } from './steps.ts';

/** The sign-in client secret's Terraform address: created without a version, filled by the CLI. */
const OIDC_SECRET_TARGETS = ['google_secret_manager_secret.oidc_client_secret[0]'] as const;

/** The Secret Manager id of the sign-in client secret: the module's `${name}-oidc-client-secret`. */
export function oidcClientSecretId(name: string): string {
  return `${name}-oidc-client-secret`;
}

const OIDC_CLIENT_ANNOTATION = 'aw-oidc-client';

/** A label-safe digest of the issuer and client id a stored secret belongs to (not secret). */
function oidcClientFingerprint({ issuer, clientId }: OidcSecretInput['oidc']): string {
  return createHash('sha256').update(`${issuer}\n${clientId}`).digest('hex').slice(0, 32);
}

/**
 * Make sure the sign-in client secret has an enabled version in Secret Manager for the current
 * `gcp.oidc` issuer and client id: create the secret through a targeted apply when it is missing,
 * and add a version only when none is enabled or the stored one was entered for another issuer or
 * client (recorded as an annotation on the secret), so an unchanged re-run asks for nothing. The
 * value comes from `readSecret` (interactive), else `AW_OIDC_CLIENT_SECRET`, and reaches `gcloud` on stdin only. Returns the value it stored, for
 * the redactor, or `null` when a version was already there.
 *
 * @throws {Error} when a version is needed and neither source has the value.
 */
export async function storeOidcClientSecret(
  context: DeployContext,
  input: OidcSecretInput,
): Promise<string | null> {
  const { project, secretId, oidc } = input;
  const fingerprint = oidcClientFingerprint(oidc);
  const storedFingerprint = await ensureOidcSecret(context, input);
  const versions = await runStep(
    context,
    'gcloud',
    [
      'secrets',
      'versions',
      'list',
      secretId,
      '--project',
      project,
      '--filter=state:enabled',
      '--limit=1',
      '--format=value(name)',
    ],
    { show: false },
  );
  if (versions.stdout.trim() !== '' && storedFingerprint === fingerprint) {
    return null;
  }
  const value = await readOidcSecretValue(input);
  await runStep(
    context,
    'gcloud',
    ['secrets', 'versions', 'add', secretId, '--project', project, '--data-file=-'],
    { show: false, input: value },
  );
  await runStep(
    context,
    'gcloud',
    [
      'secrets',
      'update',
      secretId,
      '--project',
      project,
      `--update-annotations=${OIDC_CLIENT_ANNOTATION}=${fingerprint}`,
    ],
    { show: false },
  );
  return value;
}

async function readOidcSecretValue({
  env,
  readSecret,
}: Pick<OidcSecretInput, 'env' | 'readSecret'>): Promise<string> {
  const question = 'Sign-in client secret from your identity provider (input is hidden)';
  const fromEnv = env['AW_OIDC_CLIENT_SECRET'];
  const value = (readSecret === undefined ? (fromEnv ?? '') : await readSecret(question)).trim();
  if (value === '') {
    throw new Error(
      'The sign-in client secret is needed once for this issuer and client id and is not stored ' +
        'yet. Run aw deploy production ' +
        '--yes in a terminal to be asked for it, or set AW_OIDC_CLIENT_SECRET to the secret and run ' +
        'it again. Nothing was applied.',
    );
  }
  return value;
}

async function ensureOidcSecret(context: DeployContext, input: OidcSecretInput): Promise<string> {
  const { moduleDirectory, variablesFile, project, secretId } = input;
  const described = await runStep(
    context,
    'gcloud',
    [
      'secrets',
      'describe',
      secretId,
      '--project',
      project,
      `--format=value(annotations.${OIDC_CLIENT_ANNOTATION})`,
    ],
    { show: false, accept: [0, 1] },
  );
  if (described.status !== 0) {
    await applyFoundation(context, moduleDirectory, variablesFile, OIDC_SECRET_TARGETS);
  }
  return described.stdout.trim();
}
