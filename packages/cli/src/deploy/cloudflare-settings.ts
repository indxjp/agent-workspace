import { formatStorageUrl } from '@indx-workspace/contracts/storage-url';
import type { DeployContext } from './steps.ts';
import {
  assertE2bTemplatePinned,
  awsCredentials,
  MIGRATION_VARIABLES,
  storageTarget,
  type StorageTarget,
} from './vercel.ts';

export const CLOUDFLARE_API_TOKEN_VARIABLE = 'CLOUDFLARE_API_TOKEN';
export const CLOUDFLARE_ACCOUNT_ID_VARIABLE = 'CLOUDFLARE_ACCOUNT_ID';
const CLOUDFLARE_SUBDOMAIN_VARIABLE = 'CLOUDFLARE_WORKERS_SUBDOMAIN';
export const CONTROL_PLANE_URL_VARIABLE = 'CONTROL_PLANE_URL';
export const CRON_SECRET_VARIABLE = 'CRON_SECRET';
export const BRIDGE_URL_VARIABLE = 'CLOUDFLARE_SANDBOX_BRIDGE_URL';

/** The value of a required setting, or a refusal that names it. */
export function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  purpose: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set: agent-workspace deploy reads ${purpose} from the environment, never ` +
        'from a flag or the profile. Set it and run again. Nothing was run.',
    );
  }
  return value;
}

/** The account and addresses a deploy needs from the environment, each refused by name. */
export function readSettings(context: DeployContext, dotEnv: Readonly<Record<string, string>>) {
  required(context.env, CLOUDFLARE_API_TOKEN_VARIABLE, 'the Cloudflare API token');
  const account = required(
    context.env,
    CLOUDFLARE_ACCOUNT_ID_VARIABLE,
    'the Cloudflare account id',
  );
  const subdomain = required(
    { ...dotEnv, ...context.env },
    CLOUDFLARE_SUBDOMAIN_VARIABLE,
    'the account subdomain the Workers answer under (workers.dev)',
  ).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(subdomain)) {
    throw new Error(
      `${CLOUDFLARE_SUBDOMAIN_VARIABLE} must be the account's workers.dev subdomain, the label ` +
        `before ".workers.dev"; got ${JSON.stringify(subdomain)}. Nothing was run.`,
    );
  }
  const controlPlane = required(
    { ...dotEnv, ...context.env },
    CONTROL_PLANE_URL_VARIABLE,
    'the URL the retention Cron Trigger calls',
  );
  if (!/^https:\/\/[^\s]+$/u.test(controlPlane)) {
    throw new Error(
      `${CONTROL_PLANE_URL_VARIABLE} must be an https:// URL; got ${JSON.stringify(controlPlane)}. ` +
        'Nothing was run.',
    );
  }
  return { account, subdomain, controlPlane };
}

/**
 * BH061-027: the settings a plan without the token or account id uses. It runs no Wrangler call, so
 * each unset value is shown as its own name rather than refused.
 */
export function offlineSettings(context: DeployContext, dotEnv: Readonly<Record<string, string>>) {
  const value = (environment: Readonly<Record<string, string | undefined>>, name: string) =>
    environment[name]?.trim() || `<${name}>`;
  const settings = { ...dotEnv, ...context.env };
  return {
    account: value(context.env, CLOUDFLARE_ACCOUNT_ID_VARIABLE),
    subdomain:
      settings[CLOUDFLARE_SUBDOMAIN_VARIABLE]?.trim().toLowerCase() ||
      `<${CLOUDFLARE_SUBDOMAIN_VARIABLE}>`,
    controlPlane: value(settings, CONTROL_PLANE_URL_VARIABLE),
  };
}

/** What an apply needs beyond a plan, refused by name before the first tool runs. */
export function readApplySettings(
  dotEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const migration: Record<string, string> = {};
  for (const name of MIGRATION_VARIABLES) {
    const value = dotEnv[name]?.trim() ?? '';
    if (value !== '') migration[name] = value;
  }
  const driver = dotEnv['RUNTIME_DRIVER']?.trim() ?? '';
  for (const name of ['DATABASE_URL', 'BOOTSTRAP_ADMIN']) {
    if ((migration[name] ?? '') === '') {
      throw new Error(
        `${name} is empty in .env: the control plane deploy needs it. Set it and run again. ` +
          'Nothing was run.',
      );
    }
  }
  for (const name of ['RUNNER_MANAGER_TOKEN', 'GATEWAY_TOKEN_SECRET']) {
    if ((dotEnv[name]?.trim() ?? '') === '') {
      throw new Error(
        `${name} is empty in .env: the ${name === 'GATEWAY_TOKEN_SECRET' ? 'gateway' : 'runner manager'} ` +
          'Worker answers 503 until it is set. Set it and run again. Nothing was run.',
      );
    }
  }
  assertR2Credentials(dotEnv);
  assertE2bTemplatePinned(dotEnv);
  assertSandboxBridge(dotEnv, driver);
  return migration;
}

/**
 * The control plane's R2 bucket and the `AW_STORAGE_URL` it is pushed with: the account's R2
 * endpoint and region `auto` fill what the URL leaves out. `overrides` are the secrets that replace
 * `.env`'s own storage values.
 */
export function r2Storage(
  dotEnv: Readonly<Record<string, string>>,
  account: string,
): { readonly bucket: string; readonly overrides: Readonly<Record<string, string>> } {
  const storage: StorageTarget = storageTarget(dotEnv);
  if (storage.kind === 'none') return { bucket: '', overrides: {} };
  const { location } = storage;
  if (location.kind !== 's3') {
    throw new Error(
      'AW_STORAGE_URL in .env must be an s3:// URL: a Worker keeps nothing on disk and R2 is ' +
        'S3-compatible. Nothing was run.',
    );
  }
  return {
    bucket: location.bucket,
    overrides: {
      AW_STORAGE_URL: formatStorageUrl({
        ...location,
        endpoint: location.endpoint ?? `https://${account}.r2.cloudflarestorage.com`,
        region: location.region ?? 'auto',
      }),
    },
  };
}

function assertR2Credentials(dotEnv: Readonly<Record<string, string>>): void {
  // The skills, files and session-state APIs are not installed without a working R2 key pair, and
  // every `/api/skills*` route then answers 503 `skills_runtime_not_configured`.
  const keys = awsCredentials(dotEnv);
  for (const [name, value] of [
    ['OBJECT_STORAGE_ACCESS_KEY_ID', keys['AWS_ACCESS_KEY_ID']],
    ['OBJECT_STORAGE_SECRET_ACCESS_KEY', keys['AWS_SECRET_ACCESS_KEY']],
  ] as const) {
    if ((value ?? '').trim() === '') {
      throw new Error(
        `${name} is empty in .env: the control plane reaches its R2 bucket with an R2 API ` +
          'token key pair, and without it skills, files and session state answer 503. Set it and ' +
          'run again. Nothing was run.',
      );
    }
  }
}

function assertSandboxBridge(dotEnv: Readonly<Record<string, string>>, driver: string): void {
  const bridgeUrl = dotEnv[BRIDGE_URL_VARIABLE]?.trim() ?? '';
  if (driver === 'cloudflare-sandbox' && bridgeUrl === '') {
    throw new Error(
      `${BRIDGE_URL_VARIABLE} is empty in .env: the cloudflare-sandbox driver reaches its ` +
        'sandboxes through the bridge Worker at that https URL. Set it and run again. Nothing was run.',
    );
  }
  // The manager refuses to start on anything else (`manager-start.ts`), which would be a 503 loop.
  if (
    driver === 'cloudflare-sandbox' &&
    (!bridgeUrl.startsWith('https://') || !URL.canParse(bridgeUrl))
  ) {
    throw new Error(
      `${BRIDGE_URL_VARIABLE} must be an https URL; got ${JSON.stringify(bridgeUrl)}. ` +
        'Nothing was run.',
    );
  }
}
