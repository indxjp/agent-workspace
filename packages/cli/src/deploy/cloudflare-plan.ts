import { ignoredStorageVariables } from '@indx-workspace/contracts/storage-settings';
import { ENV_IMAGE_KEYS } from '../render/env.ts';
import { registryImage, type RegistryImage } from './cloudflare-registry.ts';
import {
  BRIDGE_URL_VARIABLE,
  CLOUDFLARE_ACCOUNT_ID_VARIABLE,
  CLOUDFLARE_API_TOKEN_VARIABLE,
  CONTROL_PLANE_URL_VARIABLE,
  CRON_SECRET_VARIABLE,
  offlineSettings,
  r2Storage,
  readApplySettings,
  readSettings,
  required,
} from './cloudflare-settings.ts';
import { type DeployContext } from './steps.ts';
import type { DeployTarget } from './targets.ts';
import {
  addressOf,
  awsCredentials,
  FRONTEND_ORIGIN_VARIABLE,
  frontendDirectory,
  gatewayVariables,
  MANAGER_VARIABLES,
  managerEnvironment,
  NOT_PROJECT_VARIABLES,
  selected,
  storageTarget,
  toolHostVariables,
  withoutIgnoredStorageSettings,
} from './vercel.ts';
type Secrets = readonly (readonly [string, string])[];
type CloudflareTarget = Extract<DeployTarget, { kind: 'cloudflare' }>;

export function prepareCloudflare(
  context: DeployContext,
  target: CloudflareTarget,
  projectEnv: Readonly<Record<string, string>>,
  apply: boolean,
) {
  const dotEnv = withoutIgnoredStorageSettings(context, projectEnv);
  assertStorageConfigured(projectEnv, dotEnv, apply);
  const unset = [CLOUDFLARE_API_TOKEN_VARIABLE, CLOUDFLARE_ACCOUNT_ID_VARIABLE].filter(
    (name) => (context.env[name]?.trim() ?? '') === '',
  );
  const offline = !apply && unset.length > 0;
  const { account, subdomain, controlPlane } = offline
    ? offlineSettings(context, dotEnv)
    : readSettings(context, dotEnv);

  const cronSecret = required(dotEnv, CRON_SECRET_VARIABLE, 'the retention route secret');
  const workersDev = (worker: string) => `https://${worker}.${subdomain}.workers.dev`;
  const addresses = workerAddresses(context, target, { dotEnv, subdomain });
  const { gatewayUrl, managerUrl, frontendOrigin } = addresses;

  const webImage = dotEnv[ENV_IMAGE_KEYS.web]?.trim() ?? '';
  const driver = dotEnv['RUNTIME_DRIVER']?.trim() ?? '';
  const migration = apply ? readApplySettings(dotEnv) : {};
  const images: Readonly<Record<'web' | 'gateway' | 'runner', RegistryImage>> = {
    web: registryImage(dotEnv, 'web', account),
    gateway: registryImage(dotEnv, 'gateway', account),
    runner: registryImage(dotEnv, 'runner', account),
  };

  const r2 = r2Storage(dotEnv, account);
  const { controlPlaneSecrets, gatewaySecrets, managerSecrets, secrets } = workerSecrets(dotEnv, {
    gatewayUrl,
    managerUrl,
    frontendOrigin,
    controlPlaneOrigin: workersDev(target.controlPlaneWorkerName),
    controlPlane,
    cronSecret,
    driver,
    storageOverrides: r2.overrides,
  });

  return {
    account,
    controlPlane,
    ...addresses,
    webImage,
    driver,
    migration,
    images,
    r2,
    controlPlaneSecrets,
    gatewaySecrets,
    managerSecrets,
    secrets,
    unset,
    offline,
  };
}

export type CloudflarePlan = ReturnType<typeof prepareCloudflare>;

function workerSecrets(
  dotEnv: Readonly<Record<string, string>>,
  settings: {
    gatewayUrl: string;
    managerUrl: string;
    frontendOrigin: string | null;
    controlPlaneOrigin: string;
    controlPlane: string;
    cronSecret: string;
    driver: string;
    storageOverrides: Readonly<Record<string, string>>;
  },
) {
  const {
    gatewayUrl,
    managerUrl,
    frontendOrigin,
    controlPlaneOrigin,
    controlPlane,
    cronSecret,
    driver,
    storageOverrides,
  } = settings;
  const addresses: Secrets = [
    ['MODEL_GATEWAY_URL', gatewayUrl],
    ['RUNNER_MANAGER_URL', managerUrl],
    ...(frontendOrigin === null ? [] : [[FRONTEND_ORIGIN_VARIABLE, frontendOrigin] as const]),
  ];
  const controlPlaneSecrets: Secrets = Object.entries({
    ...dotEnv,
    ...storageOverrides,
    ...awsCredentials(dotEnv),
  })
    .filter(([name, value]) => value.trim() !== '' && !NOT_PROJECT_VARIABLES.has(name))
    .filter(([name]) => !addresses.some(([address]) => address === name))
    .concat(toolHostVariables(dotEnv).map(([name, value]) => [name, value]))
    .concat(addresses.map(([name, value]) => [name, value]));
  // The gateway forwards the Builder's aw-control MCP calls to the control plane Worker's own
  // workers.dev origin, derived like the gateway's, never from `.env` or a request.
  const gatewaySecrets: Secrets = [
    ...gatewayVariables(dotEnv),
    ['GATEWAY_CONTROL_PLANE_ORIGIN', controlPlaneOrigin],
  ];
  const managerSecrets: Secrets = [
    ...selected(managerEnvironment(dotEnv), [...MANAGER_VARIABLES, BRIDGE_URL_VARIABLE]),
    // E2B finds a session's sandbox again, so an idle-stopped manager keeps no table to lose (ADR-0126).
    ...(driver === 'external' ? [['RUNNER_MANAGER_STATELESS', 'true'] as const] : []),
    ...toolHostVariables(dotEnv),
    ['GATEWAY_PUBLIC_URL', gatewayUrl],
  ];
  // Exactly what retention-worker.mjs reads: least privilege for a retention-only Worker.
  const secrets: Secrets = [
    [CONTROL_PLANE_URL_VARIABLE, controlPlane],
    [CRON_SECRET_VARIABLE, cronSecret],
  ];

  return { controlPlaneSecrets, gatewaySecrets, managerSecrets, secrets };
}

function assertStorageConfigured(
  projectEnv: Readonly<Record<string, string>>,
  dotEnv: Readonly<Record<string, string>>,
  apply: boolean,
): void {
  // As on Vercel: old names alone used to place the store, so an apply with only them would quietly
  // run with no files, skills or session state.
  if (
    apply &&
    ignoredStorageVariables(projectEnv).length > 0 &&
    storageTarget(dotEnv).kind === 'none'
  ) {
    throw new Error(
      'AW_STORAGE_URL is empty in .env, and the old storage settings in it are ignored: the ' +
        'control plane would keep no files, skills or session state. Set AW_STORAGE_URL to the ' +
        's3:// URL of its R2 bucket and run again. Nothing was run.',
    );
  }
}

function workerAddresses(
  context: DeployContext,
  target: CloudflareTarget,
  settings: { dotEnv: Readonly<Record<string, string>>; subdomain: string },
) {
  const { dotEnv, subdomain } = settings;
  const workersDev = (worker: string) => `https://${worker}.${subdomain}.workers.dev`;
  const gatewayUrl = addressOf(
    dotEnv,
    'MODEL_GATEWAY_URL',
    target.gatewayWorkerName,
    workersDev(target.gatewayWorkerName),
  );
  const managerUrl = addressOf(
    dotEnv,
    'RUNNER_MANAGER_URL',
    target.managerWorkerName,
    workersDev(target.managerWorkerName),
  );
  const frontend = frontendDirectory(context);
  const frontendOrigin = frontend === null ? null : workersDev(target.frontendWorkerName);

  return { gatewayUrl, managerUrl, frontend, frontendOrigin };
}
