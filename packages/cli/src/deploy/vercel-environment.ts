import {
  IGNORED_STORAGE_VARIABLES,
  ignoredStorageSettingsWarning,
} from '@indx-workspace/contracts/storage-settings';
import { parseStorageUrl, type StorageLocation } from '@indx-workspace/contracts/storage-url';
import { ENV_IMAGE_KEYS, ENV_VERSION_KEY } from '../render/env.ts';
import { type DeployContext } from './steps.ts';

/**
 * `.env` keys that mean nothing on Vercel: Compose's own, and the image pins. The runtime image key
 * is not one: the control plane reads it as its engine catalogue (ADR-0073 D2), never to start a
 * container, and without it no engine is installed, so setup's runtime test probes with no engine.
 * The two sandbox image keys are the manager's alone: each replaces the runtime image there.
 */
export const NOT_PROJECT_VARIABLES: ReadonlySet<string> = new Set([
  'COMPOSE_PROJECT_NAME',
  'COMPOSE_PROFILES',
  'DOCKER_GID',
  'PORT',
  'E2B_RUNTIME_TEMPLATE',
  // Rendered below, from the driver and the template; never copied from `.env` as it stands.
  'E2B_TOOL_HOST_TEMPLATE',
  'AGENT_WORKSPACE_TOOL_HOST_IMAGE',
  'VERCEL_SANDBOX_RUNTIME_IMAGE',
  ENV_VERSION_KEY,
  ...Object.values(ENV_IMAGE_KEYS).filter((key) => key !== ENV_IMAGE_KEYS.runtime),
]);

/** What the gateway reads: the database, the secrets service, its token secret and its rates. */
const GATEWAY_VARIABLES = [
  'DATABASE_URL',
  'MASTER_KEY_PROVIDER',
  'MASTER_ENCRYPTION_KEY',
  'AZURE_KEY_VAULT_URL',
  'AZURE_MASTER_KEY_SECRET_NAME',
  'GCP_MASTER_KEY_SECRET',
  'GATEWAY_TOKEN_SECRET',
  'GATEWAY_PRICING_JSON',
] as const;

/** What the manager reads from `.env`; the rest of its configuration is computed below. */
export const MANAGER_VARIABLES = [
  'RUNNER_MANAGER_TOKEN',
  'RUNTIME_DRIVER',
  ENV_IMAGE_KEYS.runtime,
  'VERCEL_PLAN_TIER',
  'EXTERNAL_PROVIDER',
  'E2B_PLAN_TIER',
  // ADR-0132's backstop for a tool sandbox; the manager defaults it when unset.
  'AGENT_WORKSPACE_TOOL_SANDBOX_TIMEOUT_SECONDS',
] as const;

// The same pattern as `BUILD_ID_PIN` in packages/runtime/src/external/e2b.ts, which the CLI cannot import.
const E2B_TEMPLATE_PIN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * The E2B template an `external` manager runs, `<template>:<build_id>`. `render` keeps the runtime
 * image key an OCI digest, which E2B cannot run, so the template has its own `.env` key.
 */
const E2B_TEMPLATE_VARIABLE = 'E2B_RUNTIME_TEMPLATE';

/** The E2B template of the tool host, `<template>:<build_id>`: optional, and without it code tools stay refused. */
const TOOL_HOST_TEMPLATE_VARIABLE = 'E2B_TOOL_HOST_TEMPLATE';

/**
 * The production manager (`NODE_ENV=production`) refuses an `external` runtime whose image is not an
 * E2B template pinned `<template>:<build_id>` (ADR-0120 LC2) and exits 1 at start, which the host
 * reports as an unexplained crash. Refused here, by key and never by value, before anything runs.
 */
export function assertE2bTemplatePinned(dotEnv: Readonly<Record<string, string>>): void {
  if (dotEnv['RUNTIME_DRIVER']?.trim() !== 'external') return;
  const toolHost = dotEnv[TOOL_HOST_TEMPLATE_VARIABLE]?.trim() ?? '';
  for (const [name, value, optional] of [
    [E2B_TEMPLATE_VARIABLE, dotEnv[E2B_TEMPLATE_VARIABLE]?.trim() ?? '', false],
    [TOOL_HOST_TEMPLATE_VARIABLE, toolHost, true],
  ] as const) {
    if ((optional && value === '') || E2B_TEMPLATE_PIN.test(value)) continue;
    throw new Error(
      `${name} must be an E2B template pinned as <template>:<build_id> when ` +
        'RUNTIME_DRIVER is external (ADR-0120 LC2): the runner manager refuses an image digest at ' +
        'start and exits 1. Set it in .env and run again. Nothing was run.',
    );
  }
}

/**
 * The flag that tells the control plane and the manager a code tool has a host (ADR-0118). Only an
 * `external` (E2B) runtime can run one on a hosted deployment: `vercel-sandbox` and
 * `cloudflare-sandbox` render nothing, so a push that carries a code tool is still refused up front.
 */
export function toolHostVariables(
  dotEnv: Readonly<Record<string, string>>,
): readonly (readonly [string, string])[] {
  const template = dotEnv[TOOL_HOST_TEMPLATE_VARIABLE]?.trim() ?? '';
  return dotEnv['RUNTIME_DRIVER']?.trim() === 'external' && template !== ''
    ? [['AGENT_WORKSPACE_TOOL_HOST_IMAGE', template]]
    : [];
}

/**
 * What the gateway is given. With a tool host it also holds the manager token: the manager's tool
 * sandbox route requires it beside the run token (ADR-0132).
 */
export function gatewayVariables(
  dotEnv: Readonly<Record<string, string>>,
): readonly (readonly [string, string])[] {
  return [
    ...selected(dotEnv, GATEWAY_VARIABLES),
    ...(toolHostVariables(dotEnv).length === 0 ? [] : selected(dotEnv, ['RUNNER_MANAGER_TOKEN'])),
  ];
}

/**
 * The runtime image a `vercel-sandbox` manager runs: a Vercel Container Registry reference
 * `<team-slug>/<project>/<repository>@sha256:<digest>` in the manager's own project (ADR-0120 LC2).
 * A registry is project-scoped and `render` keeps the runtime image key an image any registry can
 * serve, which Vercel Sandbox cannot run, so the reference has its own `.env` key.
 */
const VERCEL_SANDBOX_IMAGE_VARIABLE = 'VERCEL_SANDBOX_RUNTIME_IMAGE';

const VERCEL_SANDBOX_IMAGE_PIN =
  /^[a-z0-9][a-z0-9-]{0,47}\/[^/@\s]+\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/u;

/**
 * A `vercel-sandbox` manager whose image is not in its own project's registry starts, then answers
 * every sandbox create with the provider's refusal (a 500 to the caller). Refused here, by key and
 * never by value, before anything runs.
 */
export function assertVercelSandboxImagePinned(
  dotEnv: Readonly<Record<string, string>>,
  projectName: string,
): void {
  if (dotEnv['RUNTIME_DRIVER']?.trim() !== 'vercel-sandbox') return;
  const reference = dotEnv[VERCEL_SANDBOX_IMAGE_VARIABLE]?.trim() ?? '';
  if (
    VERCEL_SANDBOX_IMAGE_PIN.test(reference) &&
    reference.split('/')[1] === `${projectName}-manager`
  ) {
    return;
  }
  throw new Error(
    `${VERCEL_SANDBOX_IMAGE_VARIABLE} must be <team-slug>/${projectName}-manager/<repository>@sha256:<digest> ` +
      'when RUNTIME_DRIVER is vercel-sandbox (ADR-0120 LC2): Vercel Sandbox runs only an image in ' +
      "the manager project's Vercel Container Registry and refuses any other. Push the runtime " +
      'image to vcr.vercel.com, set the reference in .env and run again. Nothing was run.',
  );
}

/**
 * `.env` as the manager reads it: an `external` runtime runs the E2B template and a `vercel-sandbox`
 * runtime its Vercel Container Registry reference, not the digest.
 */
export function managerEnvironment(
  dotEnv: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const driver = dotEnv['RUNTIME_DRIVER']?.trim();
  const image =
    driver === 'external'
      ? dotEnv[E2B_TEMPLATE_VARIABLE]?.trim()
      : driver === 'vercel-sandbox'
        ? dotEnv[VERCEL_SANDBOX_IMAGE_VARIABLE]?.trim()
        : undefined;
  return image === undefined || image === ''
    ? dotEnv
    : { ...dotEnv, [ENV_IMAGE_KEYS.runtime]: image };
}

/** The `.env` values the one-shot migration container needs, by name. Seed reads the last four. */
export const MIGRATION_VARIABLES = [
  'DATABASE_URL',
  'BOOTSTRAP_ADMIN',
  'WORKSPACE_SLUG',
  'WORKSPACE_NAME',
  'BOOTSTRAP_ADMIN_NAME',
] as const;

export const MIGRATE_AND_SEED =
  'node /srv/packages/core/dist/db/migrate.js && node /srv/packages/core/dist/db/seed.js';

/**
 * The object storage key pair under the names the web server's S3 adapter reads. Compose and Helm
 * map it the same way; an explicit `AWS_*` in `.env` wins. Empty when `.env` holds neither.
 */
export function awsCredentials(dotEnv: Readonly<Record<string, string>>): Record<string, string> {
  return {
    AWS_ACCESS_KEY_ID:
      dotEnv['AWS_ACCESS_KEY_ID']?.trim() || dotEnv['OBJECT_STORAGE_ACCESS_KEY_ID'] || '',
    AWS_SECRET_ACCESS_KEY:
      dotEnv['AWS_SECRET_ACCESS_KEY']?.trim() || dotEnv['OBJECT_STORAGE_SECRET_ACCESS_KEY'] || '',
  };
}

/** The variables `names` select from `.env`, leaving out the empty ones. */
export function selected(
  dotEnv: Readonly<Record<string, string>>,
  names: readonly string[],
): readonly (readonly [string, string])[] {
  return names.flatMap((name): [string, string][] => {
    const value = dotEnv[name]?.trim() ?? '';
    return value === '' ? [] : [[name, value]];
  });
}

/**
 * `.env` without the old storage variables, which the server ignores, so a deploy never pushes them
 * to the platform project. Warns once, naming each and never a value (Q-18).
 */
export function withoutIgnoredStorageSettings(
  context: DeployContext,
  dotEnv: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const warning = ignoredStorageSettingsWarning(dotEnv);
  if (warning === null) return dotEnv;
  context.err(`${warning}\n`);
  return Object.fromEntries(
    Object.entries(dotEnv).filter(([name]) => !IGNORED_STORAGE_VARIABLES.includes(name)),
  );
}

export type StorageTarget =
  { readonly kind: 'url'; readonly location: StorageLocation } | { readonly kind: 'none' };

/**
 * Where `.env` says the object store is (the storage design, §04): `AW_STORAGE_URL` alone. The old
 * location names are ignored, never translated. A refusal names variables and never a value.
 */
export function storageTarget(dotEnv: Readonly<Record<string, string>>): StorageTarget {
  const raw = dotEnv['AW_STORAGE_URL']?.trim() ?? '';
  if (raw === '') return { kind: 'none' };
  const parsed = parseStorageUrl(raw);
  if (!parsed.ok) {
    throw new Error(`AW_STORAGE_URL in .env is not valid: ${parsed.reason}. Nothing was run.`);
  }
  return { kind: 'url', location: parsed.location };
}

/**
 * A Vercel function has no writable disk to keep skills, files and session state on, so the
 * control plane needs an S3-compatible bucket and its key pair (R2, S3, Tigris...). Without them
 * every `/api/skills*` route answers 503 `skills_runtime_not_configured` and `aw push` fails.
 * Vercel Blob is not the object store (ADR-0120 LC8).
 */
export function assertObjectStorageConfigured(dotEnv: Readonly<Record<string, string>>): void {
  const storage = storageTarget(dotEnv);
  if (storage.kind === 'url' && storage.location.kind === 'file') {
    throw new Error(
      'AW_STORAGE_URL in .env is a file: URL, and a Vercel function keeps nothing on disk. Use ' +
        'an s3:// URL for an S3-compatible bucket. Nothing was run.',
    );
  }
  if (storage.kind === 'url' && storage.location.kind !== 's3') return;
  const keys = awsCredentials(dotEnv);
  for (const [name, value] of [
    ...(storage.kind === 'none' ? ([['AW_STORAGE_URL', '']] as const) : []),
    ['OBJECT_STORAGE_ACCESS_KEY_ID', keys['AWS_ACCESS_KEY_ID']],
    ['OBJECT_STORAGE_SECRET_ACCESS_KEY', keys['AWS_SECRET_ACCESS_KEY']],
  ] as const) {
    if ((value ?? '').trim() === '') {
      throw new Error(
        `${name} is empty in .env: a Vercel function keeps nothing on disk, so the control plane ` +
          'needs an S3-compatible bucket (for a non-AWS store such as R2, name its endpoint in ' +
          'the storage setting) and its key pair, and without them skills, files and session ' +
          'state answer 503 (and aw push fails). Create the bucket, set the value and run ' +
          'again. Nothing was run.',
      );
    }
  }
}
