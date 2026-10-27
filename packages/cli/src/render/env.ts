/**
 * The deployment profile rendered to the environment the platform actually reads.
 *
 * This is the one place in the repository where the mapping from a profile to `DATABASE_URL`,
 * `OBJECT_STORAGE_*`, `MASTER_ENCRYPTION_KEY`, `BOOTSTRAP_ADMIN` and the rest exists in code;
 * `.env.example` is the documented inventory it is held against by `env.test.ts`, and
 * `docs/sdk/site/concepts/data-plane.mdx` prints the same table with each variable's reader.
 *
 * A value only the target can know — a managed database's URL, an IAM-supplied object-store
 * credential — is rendered empty under a comment naming what supplies it, the way `.env.example`
 * leaves the values an operator must fill. Secrets are injected, never derived here, so the
 * function is pure and its output is byte-stable for a given input.
 *
 * Every cloud renders the same key set with four deliberate exceptions, all of them Compose's
 * own: `POSTGRES_IMAGE` and `SEAWEEDFS_IMAGE` pin services no cloud deployment runs, `PORT` is
 * the host port `templates/compose.yaml` publishes the web service on, and `COMPOSE_PROJECT_NAME`
 * names the Compose project and its networks. So only `local` renders them.
 */
import { createHash } from 'node:crypto';

import { formatStorageUrl } from '@indx-workspace/contracts/storage-url';

import { COMPOSE_PROJECT_NAME_PATTERN, RESERVED_COMPOSE_PROJECT_NAME } from '../compose-project.ts';
import { CLAUDE_AGENT_SDK_RUNTIME_IMAGE_KEY, type DeploymentImages } from '../deployment.ts';
import type { DeploymentCloud, DeploymentProfile } from '../profile.ts';
import { PLATFORM_IMAGE_VERSION } from '../release-images.ts';

/**
 * The release the pinned image digests were resolved for, rendered on `vercel` alone: a Vercel
 * deploy uploads a source checkout and runs the migrations from `WEB_IMAGE`, and a digest does not
 * say which release it is. `render` does not own this line (it is written at generation, with the
 * digests it describes), so a re-render never makes it claim a release the digests are not.
 */
export const ENV_VERSION_KEY = 'AGENT_WORKSPACE_VERSION';

/** Generated credentials, passed in so the renderer stays pure and its goldens stay stable. */
export interface EnvSecrets {
  readonly adminPassword: string;
  readonly postgresPassword: string;
  /** The secret key of the Compose project's SeaweedFS identity (ADR-0067). */
  readonly objectStoreSecretKey: string;
  readonly masterEncryptionKey: string;
  readonly gatewayTokenSecret: string;
  readonly runnerManagerToken: string;
  readonly sessionSecret: string;
  /** Bearer of the cron-driven retention route (ADR-0120 clause 7); rendered on `vercel` and `cloudflare`. */
  readonly cronSecret: string;
}

export interface EnvRenderInput {
  readonly profile: DeploymentProfile;
  readonly secrets: EnvSecrets;
  readonly images: DeploymentImages;
  /** The host's `docker.sock` group, so the runner can reach the daemon without running as root. */
  readonly dockerGroupId: number;
  /** The generated project's directory name; the Compose project is named after it. */
  readonly projectName: string;
  /** The host port the Compose web service is published on (`--port`); 3000 when absent. */
  readonly webPort?: number;
}

/** Long enough to stay recognisable, short enough that `<name>-runtime-control` stays readable. */
const COMPOSE_PROJECT_NAME_MAX_LENGTH = 48;

/**
 * The Compose project name for a generated project, from its directory name.
 *
 * `templates/compose.yaml` names its project, and the two networks the runner and the gateway
 * find by name, after it. A fixed name would let a second generated project, or the repository's
 * own development stack, adopt this project's containers and remove its orphans. A directory whose
 * name has no usable character (for example one written in another script) gets a stable name
 * derived from a hash of it rather than a refusal, as does the reserved name `agent-workspace`.
 */
export function composeProjectName(directoryName: string): string {
  const slug = directoryName
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/gu, '-')
    .replaceAll(/-+/gu, '-')
    .replace(/^[_-]+/u, '')
    .slice(0, COMPOSE_PROJECT_NAME_MAX_LENGTH)
    .replace(/[_-]+$/u, '');
  if (COMPOSE_PROJECT_NAME_PATTERN.test(slug) && slug !== RESERVED_COMPOSE_PROJECT_NAME)
    return slug;
  return `agent-workspace-${createHash('sha256').update(directoryName).digest('hex').slice(0, 12)}`;
}

/**
 * The unconfigured price catalogue. It matches no real provider/model on purpose, so no run is
 * ever priced from a guess: each settles unpriced (cost zero, no price table version, accounting
 * state `unavailable`, issue #134) until an operator replaces it with reviewed rates
 * (`.env.example`).
 */
const UNCONFIGURED_PRICING =
  '{"version":"unconfigured","models":{"disabled:unconfigured":' +
  '{"inputUsdPerMillion":"0","outputUsdPerMillion":"0"}}}';

/**
 * The Compose project's SeaweedFS service, exactly as `templates/compose.yaml` runs it: its S3
 * gateway listens on 8333, and the access key id is an identifier, not a secret, so it is fixed
 * the way the PostgreSQL user is.
 */
const COMPOSE_OBJECT_STORE_ENDPOINT = 'http://seaweedfs:8333';
/** The loopback host port `templates/compose.yaml` publishes that gateway on (`SEAWEEDFS_PORT`). */
const COMPOSE_OBJECT_STORE_HOST_PORT = 8333;
/** Where the host's browser reaches that gateway: the published port above. */
const COMPOSE_OBJECT_STORE_PUBLIC_ENDPOINT = `http://localhost:${String(COMPOSE_OBJECT_STORE_HOST_PORT)}`;
const COMPOSE_OBJECT_STORE_ACCESS_KEY_ID = 'agent_workspace';

interface ObjectStorePlacement {
  readonly backend: string;
  readonly endpoint: string;
  readonly publicEndpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: string;
}

/**
 * Where the object store is, per profile. The endpoint and addressing style are derived from the
 * cloud rather than carried in the profile: Compose's SeaweedFS has a fixed address, AWS S3 has no
 * endpoint to state, and native GCS uses ADC rather than an S3 endpoint.
 */
function objectStorePlacement(
  profile: DeploymentProfile,
  objectStoreSecretKey: string,
): ObjectStorePlacement {
  const empty = {
    endpoint: '',
    publicEndpoint: '',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
  };
  if (profile.storage.objects === 'local-filesystem') {
    return { ...empty, backend: '', forcePathStyle: 'true' };
  }
  if (profile.storage.objects.startsWith('azblob://')) {
    return {
      ...empty,
      backend: 'azure-blob',
      bucket: profile.storage.objects.slice('azblob://'.length),
      forcePathStyle: 'false',
    };
  }
  const scheme = profile.storage.objects.startsWith('gcs://') ? 'gcs' : 's3';
  const bucket = profile.storage.objects.slice(`${scheme}://`.length);
  if (scheme === 'gcs') {
    return { ...empty, backend: 'gcs', bucket, forcePathStyle: 'false' };
  }
  if (profile.cloud === 'local') {
    return {
      // Blank preserves the platform-owned bundled-store path, including first-boot bucket
      // creation. Explicit `s3` declares an operator-provisioned bucket.
      backend: '',
      endpoint: COMPOSE_OBJECT_STORE_ENDPOINT,
      publicEndpoint: COMPOSE_OBJECT_STORE_PUBLIC_ENDPOINT,
      bucket,
      accessKeyId: COMPOSE_OBJECT_STORE_ACCESS_KEY_ID,
      secretAccessKey: objectStoreSecretKey,
      forcePathStyle: 'true',
    };
  }
  // An S3 deployment's object credential is an IAM role or a key held by the cloud's own secret
  // service, never a value this generator can know — so the keys are left for it to fill.
  return {
    ...empty,
    backend: 's3',
    bucket,
    forcePathStyle: 'false',
  };
}

function composeOnly(profile: DeploymentProfile, value: string): string {
  return profile.cloud === 'local' ? value : '';
}

/**
 * What supplies the two object-store keys on a cloud target, named above the blanks it leaves.
 *
 * Compose's SeaweedFS credential is one this generator invents, so `local` gets no comment; a cloud
 * that names a bucket leaves both keys empty, and a blank with nothing saying who fills it is the
 * failure this line exists to prevent.
 *
 * The gate is the store, not the cloud: native GCS and Blob use workload identity, while S3 may
 * use either workload identity or explicit keys.
 */
function objectCredentialLines(profile: DeploymentProfile): readonly string[] {
  if (profile.cloud === 'local' || profile.storage.objects === 'local-filesystem') return [];
  if (profile.storage.objects.startsWith('azblob://')) {
    return [
      '# Azure Blob authenticates with the web Container App managed identity. No account key,',
      '# connection string or SAS token belongs in this file.',
    ];
  }
  if (profile.storage.objects.startsWith('gcs://')) {
    return [
      '# Native GCS uses Application Default Credentials from the deployment service account;',
      '# no HMAC key belongs in this file.',
    ];
  }
  if (profile.cloud === 'cloudflare') {
    return [
      "# R2 is reached through the S3 adapter with an R2 API token's access key pair (R2 > Manage",
      '# API tokens); fill both. Region is `auto` (https://developers.cloudflare.com/r2/api/s3/api/,',
      '# checked 2026-10-08).',
    ];
  }
  return [
    "# The two keys below are the cloud's to supply: the pod's IAM role or workload identity, or a",
    "# key held by the cloud's own key service. Leave both empty when the service account itself",
    '# grants the bucket — the S3 client then signs with the identity the pod already has.',
  ];
}

/** Where the Compose and `local-filesystem` profiles keep files, skills and session transcripts. */
const LOCAL_STORAGE_ROOT = '/var/lib/agent-workspace';

/**
 * The `AW_STORAGE_URL` a profile renders (the storage design, §04), or `''` when a Terraform module
 * supplies it. The bundled SeaweedFS gets the bucket, endpoint and path style the old names gave
 * it, so a project's existing objects stay where they are.
 */
function storageUrl(profile: DeploymentProfile): string {
  const objects = profile.storage.objects;
  if (objects === 'local-filesystem') {
    return formatStorageUrl({ kind: 'file', root: LOCAL_STORAGE_ROOT });
  }
  // The Blob account is a Terraform output, so the Container Apps module supplies the store.
  if (objects.startsWith('azblob://')) return '';
  const bucket = objects.slice(objects.indexOf('://') + '://'.length);
  if (objects.startsWith('gcs://')) return formatStorageUrl({ kind: 'gcs', bucket, prefix: '' });
  if (profile.cloud === 'local') {
    return formatStorageUrl({
      kind: 's3',
      bucket,
      prefix: '',
      endpoint: COMPOSE_OBJECT_STORE_ENDPOINT,
      publicEndpoint: COMPOSE_OBJECT_STORE_PUBLIC_ENDPOINT,
      forcePathStyle: true,
    });
  }
  // `deploy` adds the account's R2 endpoint, which only it knows.
  return formatStorageUrl({
    kind: 's3',
    bucket,
    prefix: '',
    ...(profile.cloud === 'cloudflare' ? { region: 'auto' } : {}),
    forcePathStyle: false,
  });
}

const SIGNED_UPLOAD_LINES = [
  '# Largest signed upload in bytes. Blank keeps the server default, 5 GiB.',
  'AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES=',
];

function storageUrlLines(
  profile: DeploymentProfile,
  url: string,
  objects: ObjectStorePlacement,
): readonly string[] {
  return [
    '# Where files, skills and session transcripts live, in one URL. No key or password belongs in',
    '# it: the credential lines below, or the workload identity, supply those.',
    ...(profile.storage.objects.startsWith('azblob://')
      ? [
          '# Leave blank: the Container Apps Terraform module supplies the Blob store',
          '# (azblob://<account>/<container>); the storage account is one of its outputs.',
        ]
      : []),
    `AW_STORAGE_URL=${url}`,
    ...(objects.endpoint === COMPOSE_OBJECT_STORE_ENDPOINT
      ? [
          '# The bundled SeaweedFS starts empty: the server creates the bucket on first boot.',
          'AW_STORAGE_CREATE_BUCKET=true',
        ]
      : []),
    ...SIGNED_UPLOAD_LINES,
    ...objectCredentialLines(profile),
    `OBJECT_STORAGE_ACCESS_KEY_ID=${objects.accessKeyId}`,
    `OBJECT_STORAGE_SECRET_ACCESS_KEY=${objects.secretAccessKey}`,
  ];
}

/** The Compose project's PostgreSQL service, exactly as `templates/compose.yaml` runs it. */
const COMPOSE_POSTGRES_USER = 'agent_workspace';
const COMPOSE_POSTGRES_DATABASE = 'agent_workspace';

function composePostgresUrl(password: string): string {
  return `postgres://${COMPOSE_POSTGRES_USER}:${password}@postgres:5432/${COMPOSE_POSTGRES_DATABASE}`;
}

/**
 * Who provisions a managed store the profile names by name, and how its URL reaches the
 * deployment. `gcp` and `azure` have an `infra/terraform` module that provisions the store and
 * writes `DATABASE_URL` into the cloud's secret service. AWS has none — an EKS cluster the
 * operator already runs is installed with the chart alone — so naming a module there would point
 * an operator at something that does not exist.
 */
function relationalProvisioner(cloud: DeploymentCloud): string | null {
  if (cloud === 'local') return null;
  if (cloud === 'vercel') {
    return (
      '# The Vercel Marketplace Neon integration supplies DATABASE_URL as a project environment ' +
      'variable.'
    );
  }
  if (cloud === 'cloudflare') {
    return (
      '# Cloudflare has no PostgreSQL of its own: provision Neon or Supabase and put its URL here ' +
      '(direct TCP).'
    );
  }
  if (cloud === 'aws') {
    return (
      '# You provision it and put its URL in the Secret the chart names in ' +
      'external.databaseUrlSecret.'
    );
  }
  return `# The ${cloud} module provisions it and supplies DATABASE_URL as a secret.`;
}

/**
 * The relational block.
 *
 * `agent-workspace.yaml` names the store; the connection string is a credential, so it exists
 * here and nowhere else. `compose-postgres` names the service this generator itself writes, whose
 * password it also generates, so its URL is assembled from both.
 */
function relationalLines(profile: DeploymentProfile, postgresPassword: string): readonly string[] {
  const stated = profile.storage.relational.includes('://');
  const provisioner = stated ? null : relationalProvisioner(profile.cloud);
  const url = stated ? profile.storage.relational : '';
  return [
    `# Relational store: ${profile.storage.relational}`,
    ...(provisioner === null ? [] : [provisioner]),
    `POSTGRES_USER=${composeOnly(profile, COMPOSE_POSTGRES_USER)}`,
    `POSTGRES_PASSWORD=${composeOnly(profile, postgresPassword)}`,
    `POSTGRES_DB=${composeOnly(profile, COMPOSE_POSTGRES_DATABASE)}`,
    `DATABASE_URL=${stated ? url : composeOnly(profile, composePostgresUrl(postgresPassword))}`,
  ];
}

/** An image key of the rendered `.env`, and the reference it pins. */
export type EnvImageEntry = readonly [key: string, reference: string];

/**
 * The `.env` key each image is pinned under. `agent-workspace render` reads the pins back through
 * this map and rewrites exactly these keys, so it is the one statement of which `.env` lines the
 * renderer owns after generation.
 */
export const ENV_IMAGE_KEYS: Readonly<Record<keyof Required<DeploymentImages>, string>> = {
  web: 'WEB_IMAGE',
  gateway: 'GATEWAY_IMAGE',
  runner: 'RUNNER_IMAGE',
  // ENG-07 (ADR-0073): one runtime image per engine, keyed by engine id. Only the Claude engine
  // has an image today; each later engine unit adds its own key.
  runtime: CLAUDE_AGENT_SDK_RUNTIME_IMAGE_KEY,
  postgres: 'POSTGRES_IMAGE',
  seaweedfs: 'SEAWEEDFS_IMAGE',
};

/**
 * The image lines of the rendered `.env`, in the order they are written.
 *
 * `POSTGRES_IMAGE` and `SEAWEEDFS_IMAGE` pin two services only the Compose project runs. A cloud
 * deployment takes its database and its bucket from the cloud, so requiring those two pins there
 * would make the generator resolve — and the release gate demand — digests for images nothing in
 * that deployment ever pulls.
 */
export function envImageEntries(
  profile: DeploymentProfile,
  images: DeploymentImages,
): readonly EnvImageEntry[] {
  const platform: EnvImageEntry[] = [
    [ENV_IMAGE_KEYS.web, images.web],
    [ENV_IMAGE_KEYS.gateway, images.gateway],
    [ENV_IMAGE_KEYS.runner, images.runner],
    [ENV_IMAGE_KEYS.runtime, images.runtime],
  ];
  if (profile.cloud !== 'local') return platform;
  const { postgres, seaweedfs } = images;
  if (postgres === undefined || seaweedfs === undefined) {
    throw new Error(
      'The Compose project pins POSTGRES_IMAGE and SEAWEEDFS_IMAGE; both must be resolved for ' +
        'cloud "local".',
    );
  }
  return [...platform, [ENV_IMAGE_KEYS.postgres, postgres], [ENV_IMAGE_KEYS.seaweedfs, seaweedfs]];
}

interface ServiceAddresses {
  readonly runner: string;
  readonly runnerManager: string;
  readonly gateway: string;
  readonly sessionMirror: string;
}

/**
 * Where each component answers, per deployment shape.
 *
 * The Compose project's addresses are its own service names (`templates/compose.yaml`). A cloud
 * target installs the chart, so the addresses are the Services
 * `infra/helm/agent-workspace/templates/services.yaml` publishes;
 * `infra/tests/contracts.test.mjs` holds the rendered goldens against that file, so a renamed
 * Service is a failing test rather than a deployment that cannot reach its gateway.
 *
 * `RUNNER_URL` is the one address a cluster does not have. The chart deploys no runner: the
 * runner-manager creates each sandbox and returns its address per run, so the variable is
 * rendered empty under a comment saying so rather than pointing at a Service that does not exist.
 */
function serviceAddresses(profile: DeploymentProfile): ServiceAddresses {
  if (profile.cloud === 'local') {
    return {
      runner: 'http://runner:8080',
      runnerManager: 'http://runner:8090',
      gateway: 'http://gateway:4000',
      sessionMirror: 'http://web:3000',
    };
  }
  if (profile.cloud === 'vercel' || profile.cloud === 'cloudflare') {
    // Gateway and runner-manager placement on these hosts is decided per deployment, so none is guessed.
    return { runner: '', runnerManager: '', gateway: '', sessionMirror: '' };
  }
  return {
    runner: '',
    runnerManager: 'http://agent-workspace-runner-manager:8080',
    gateway: 'http://agent-workspace-gateway:4000',
    sessionMirror: 'http://agent-workspace-web:3000',
  };
}

/**
 * Exact count of proxies that prepend `X-Forwarded-For` before a request reaches the web process.
 * The Compose project publishes the web port directly, so nothing rewrites the header; every cloud
 * target sits behind exactly one load balancer or ingress. Runnable public shares fail closed
 * when this is absent or wrong, so it is stated rather than left blank.
 */
function trustedProxyHops(profile: DeploymentProfile): string {
  return profile.cloud === 'local' ? '0' : '1';
}

function identityLines(profile: DeploymentProfile): readonly string[] {
  if (profile.identity.oidc === undefined) return [];
  return [
    '# Identity: the issuer comes from the profile. The client registration is per-deployment and',
    '# its secret never enters a checked-in file — all four must be set together, or none.',
    `OIDC_ISSUER_URL=${profile.identity.oidc}`,
    'OIDC_CLIENT_ID=',
    'OIDC_CLIENT_SECRET=',
    'OIDC_REDIRECT_URI=',
  ];
}

/** Render the profile to the deployment's `.env`. */
export function renderEnv(input: EnvRenderInput): string {
  const { profile, secrets, images } = input;
  const objects = objectStorePlacement(profile, secrets.objectStoreSecretKey);
  const url = storageUrl(profile);
  const addresses = serviceAddresses(profile);

  return [
    '# Generated by create-agent-workspace from agent-workspace.yaml.',
    '# `agent-workspace render` rewrites only the image lines below from agent-workspace.yaml;',
    '# every other line is yours to edit and keeps its value. Replace every secret before exposure.',
    '# Images are immutable process contracts, pinned by digest.',
    ...(profile.cloud === 'local'
      ? [
          '# The Compose project, and its runtime-control and provider-egress networks, are named',
          '# after this directory, so projects on one Docker host never adopt each other. Two',
          '# directories with the same name share it: set a distinct name here to run both.',
          `COMPOSE_PROJECT_NAME=${composeProjectName(input.projectName)}`,
        ]
      : []),
    ...envImageEntries(profile, images).map(([key, reference]) => `${key}=${reference}`),
    ...(profile.cloud === 'vercel'
      ? [
          '# The release the images above were resolved for. `deploy` refuses a source checkout at',
          '# another release, because the migrations run from WEB_IMAGE and the code from the checkout.',
          `${ENV_VERSION_KEY}=${PLATFORM_IMAGE_VERSION}`,
        ]
      : []),
    `DOCKER_GID=${input.dockerGroupId}`,
    ...relationalLines(profile, secrets.postgresPassword),
    `# Object store: ${profile.storage.objects}`,
    // The identity `templates/compose.yaml` gives the SeaweedFS service. Rendered for every
    // Compose project, whichever store it selected: Compose interpolates the whole file before it
    // applies profiles, so the service's `${…:?}` demands must hold even when it never starts.
    `SEAWEEDFS_ACCESS_KEY_ID=${composeOnly(profile, COMPOSE_OBJECT_STORE_ACCESS_KEY_ID)}`,
    `SEAWEEDFS_SECRET_ACCESS_KEY=${composeOnly(profile, secrets.objectStoreSecretKey)}`,
    '# The loopback host port SeaweedFS is published on. Change it to run beside another project',
    '# that uses 8333, and change the publicEndpoint port in AW_STORAGE_URL with it.',
    `SEAWEEDFS_PORT=${composeOnly(profile, String(COMPOSE_OBJECT_STORE_HOST_PORT))}`,
    `COMPOSE_PROFILES=${objects.endpoint === COMPOSE_OBJECT_STORE_ENDPOINT ? 'object-storage' : ''}`,
    ...storageUrlLines(profile, url, objects),
    `AWS_REGION=${profile.cloud === 'cloudflare' ? 'auto' : 'us-east-1'}`,
    `# Runtime: ${profile.runtime.default}`,
    `RUNTIME_DRIVER=${profile.runtime.default}`,
    ...(profile.runtime.default === 'external'
      ? [`EXTERNAL_PROVIDER=${profile.runtime.provider ?? 'e2b'}`]
      : []),
    ...(profile.cloud === 'local'
      ? []
      : profile.cloud === 'vercel'
        ? [
            '# Vercel runs no Services: the gateway and the runner-manager are Vercel projects of their',
            '# own. `deploy` points the control plane at their production URLs unless you set',
            '# MODEL_GATEWAY_URL or RUNNER_MANAGER_URL below (a custom domain); RUNNER_URL has none.',
          ]
        : profile.cloud === 'cloudflare'
          ? [
              '# Cloudflare runs no Kubernetes Services: the gateway and runner-manager addresses are',
              '# set when they are placed, so the three addresses below stay empty until then.',
            ]
          : [
              '# The three addresses below are the Services infra/helm/agent-workspace publishes; a',
              '# Cloud Run or Container Apps deployment is given them by its Terraform module instead.',
              '# RUNNER_URL has no fixed address in either: the runner-manager creates each sandbox',
              '# and returns its address per run, so there is no runner Service to name.',
            ]),
    `RUNNER_URL=${addresses.runner}`,
    `RUNNER_MANAGER_URL=${addresses.runnerManager}`,
    `RUNNER_MANAGER_TOKEN=${secrets.runnerManagerToken}`,
    '# Replace this sentinel with reviewed provider:model rates before the first run: until then',
    '# every run settles unpriced (cost 0.000000, accountingState "unavailable").',
    `GATEWAY_PRICING_JSON=${UNCONFIGURED_PRICING}`,
    `MODEL_GATEWAY_URL=${addresses.gateway}`,
    `AW_SESSION_MIRROR_URL=${addresses.sessionMirror}`,
    'WORKSPACE_SLUG=default',
    'WORKSPACE_NAME=Default Workspace',
    `# Secret backend: ${profile.storage.secrets}`,
    `MASTER_KEY_PROVIDER=${profile.storage.secrets}`,
    `AZURE_KEY_VAULT_URL=`,
    `AZURE_MASTER_KEY_SECRET_NAME=${profile.storage.secrets === 'key-vault' ? 'master-encryption-key' : ''}`,
    ...(profile.storage.secrets === 'secret-manager'
      ? ['# Terraform supplies the full Secret Manager version resource on GCP.']
      : []),
    'GCP_MASTER_KEY_SECRET=',
    ...(profile.storage.secrets === 'kms'
      ? [
          '# Supply the KMS key id and encrypted 32-byte deployment key through the Kubernetes',
          '# Secret named by the chart. The plaintext key never belongs in this file.',
          'AWS_KMS_KEY_ID=',
          'AWS_KMS_ENCRYPTED_MASTER_KEY=',
        ]
      : []),
    `BOOTSTRAP_ADMIN=${profile.identity.bootstrapAdmin}`,
    `BOOTSTRAP_ADMIN_PASSWORD=${secrets.adminPassword}`,
    `SESSION_SECRET=${secrets.sessionSecret}`,
    `MASTER_ENCRYPTION_KEY=${profile.storage.secrets === 'local-key' ? secrets.masterEncryptionKey : ''}`,
    `GATEWAY_TOKEN_SECRET=${secrets.gatewayTokenSecret}`,
    ...(profile.cloud === 'vercel'
      ? [
          '# Vercel Cron sends this as `Authorization: Bearer`; the retention route is inert without it.',
          `CRON_SECRET=${secrets.cronSecret}`,
        ]
      : []),
    ...(profile.cloud === 'cloudflare'
      ? [
          '# The Cron Trigger Worker sends this as `Authorization: Bearer`; the retention route is',
          '# inert without it.',
          `CRON_SECRET=${secrets.cronSecret}`,
        ]
      : []),
    ...identityLines(profile),
    '# Exact count of proxies that prepend X-Forwarded-For; public shares fail closed if it is wrong.',
    `AW_TRUSTED_PROXY_HOPS=${trustedProxyHops(profile)}`,
    // The host port `templates/compose.yaml` publishes the web service on. A cluster takes the
    // listener from the chart, which sets PORT per container from the port that container
    // publishes, so rendering it here would be a value nothing reads and a Secret could disagree
    // with.
    ...(profile.cloud === 'local'
      ? [
          '# The host address and port the web service is published on, loopback only by default.',
          '# Change the port when 3000 is taken, or to run a second generated project beside this',
          '# one; `agent-workspace start` checks it is free before it starts anything. Write the',
          '# port alone (PORT=3000) to publish on every interface, e.g. for a remote Docker daemon.',
          `PORT=127.0.0.1:${String(input.webPort ?? 3000)}`,
        ]
      : []),
    '',
  ].join('\n');
}
