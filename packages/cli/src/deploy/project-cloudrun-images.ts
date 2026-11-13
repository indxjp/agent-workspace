import type { ProductionApp, ProductionEnvironment } from '@indx-workspace/contracts/project-file';

import {
  resolveDeploymentImages,
  resolveEgressProxyImage,
  resolveToolHostImage,
  type DeploymentImages,
} from '../deployment.ts';
import {
  PLATFORM_IMAGES_PINNED,
  PLATFORM_IMAGE_VERSION,
  platformImageReference,
} from '../release-images.ts';
import { ENV_IMAGE_KEYS } from '../render/env.ts';
import {
  CLOUD_RUN_IMAGES,
  copyImagesToArtifactRegistry,
  type CloudRunImage,
} from './cloud-run-images.ts';
import { appVariables } from './gcp-lifecycle.ts';
import { type CloudRunModule, type DeployProjectEnvironmentOptions } from './project-types.ts';
import type { DeployContext } from './steps.ts';

/** The override variable and release field of each platform image `cloudRunImages` resolves. */
const OVERRIDES = [
  ['AW_WEB_IMAGE', 'web'],
  ['AW_GATEWAY_IMAGE', 'gateway'],
  ['AW_RUNNER_IMAGE', 'runner'],
  ['AW_RUNTIME_IMAGE', 'runtime'],
  ['AW_TOOL_HOST_IMAGE', 'toolHost'],
  ['AW_EGRESS_PROXY_IMAGE', 'egressProxy'],
] as const;

/**
 * Say what the user's own environment changed about the release: each `AW_*_IMAGE` override is
 * named, and an unpinned (source) CLI says its tags came from the registry.
 */
function reportOverrides(
  context: DeployContext,
  env: NodeJS.ProcessEnv | undefined,
  resolved: Readonly<Record<string, string | undefined>>,
  sandboxInternet: boolean,
): void {
  const user = env ?? process.env;
  let overridden = false;
  for (const [variable, field] of OVERRIDES) {
    if (user[variable] === undefined || (field === 'egressProxy' && !sandboxInternet)) continue;
    overridden = true;
    context.err(
      `warning: ${variable} overrides the pinned release image; this deploy uses ` +
        `${resolved[field] ?? user[variable]}, which this CLI release did not pin.\n`,
    );
  }
  if (!PLATFORM_IMAGES_PINNED && !overridden) {
    context.out(
      'This CLI carries no release digests (a source build), so image tags were resolved from the registry.\n',
    );
  }
}

/** The references that are this CLI's own pinned release images, which cosign can verify. */
function releaseReferences(
  references: Readonly<Partial<Record<(typeof OVERRIDES)[number][1], string>>>,
): ReadonlySet<string> {
  if (!PLATFORM_IMAGES_PINNED) return new Set();
  return new Set(
    OVERRIDES.flatMap(([, field]) =>
      references[field] === platformImageReference(field) ? [platformImageReference(field)] : [],
    ),
  );
}

/**
 * Cloud Run pulls only from Artifact Registry, so each image's reference — what `render` will pin:
 * an `AW_<NAME>_IMAGE` override, else `pinned` (the existing state's pin, or the images a first run
 * was given), else the release default on ghcr.io — is copied there by digest when it is not
 * already. `null` when copies were pending and a plan copied nothing: no state may pin them yet,
 * unless `registry` is the computed destination, which a plan can show. Otherwise the copies are
 * returned as the overrides that make `render` pin them. The tool host is always copied too, as the
 * fifth image; the sandbox egress proxy only with `sandboxInternet` (`gcp.sandboxInternet`), and
 * each app image of `apps` into its own repository `app-<name>`, returned as `apps`.
 */
export async function cloudRunImages(
  options: DeployProjectEnvironmentOptions,
  copy: {
    readonly cloudRunModule: CloudRunModule;
    readonly pins: Readonly<Record<string, string>> | null;
    readonly ownerEmail: string;
    readonly context: DeployContext;
    readonly sandboxInternet: boolean;
    readonly apps: Readonly<Record<string, ProductionApp>>;
    readonly registry?: string;
  },
): Promise<CopiedReleaseImages | null> {
  const { cloudRunModule, pins, ownerEmail, context, sandboxInternet, apps, registry } = copy;
  const pinned: Partial<Record<CloudRunImage, string>> = {};
  for (const name of CLOUD_RUN_IMAGES) {
    const reference = pins === null ? options.images?.[name] : pins[ENV_IMAGE_KEYS[name]];
    if (reference !== undefined) pinned[name] = reference;
  }
  const resolved = resolveDeploymentImages('gcp', options.env, pinned);
  const egressPin = pins === null ? options.images?.egressProxy : pins[ENV_IMAGE_KEYS.egressProxy];
  const egressProxy = sandboxInternet
    ? { egressProxy: resolveEgressProxyImage(options.env, egressPin) }
    : {};
  const toolHostPin = pins === null ? options.images?.toolHost : pins[ENV_IMAGE_KEYS.toolHost];
  const toolHost = resolveToolHostImage(options.env, toolHostPin);
  reportOverrides(context, options.env, { ...resolved, toolHost, ...egressProxy }, sandboxInternet);
  const appImages = Object.fromEntries(
    Object.entries(apps).map(([name, app]) => [name, app.image]),
  );
  const sources =
    registry === undefined
      ? undefined
      : () => ({
          ...(options.images ?? resolveDeploymentImages('gcp', options.env)),
          toolHost: resolveToolHostImage(options.env, options.images?.toolHost),
          ...(sandboxInternet
            ? { egressProxy: resolveEgressProxyImage(options.env, options.images?.egressProxy) }
            : {}),
          apps: appImages,
        });
  const copied = await copyImagesToArtifactRegistry({
    context,
    ...(registry === undefined || sources === undefined ? {} : { registry, sources }),
    moduleDirectory: cloudRunModule.moduleDirectory,
    references: {
      web: resolved.web,
      gateway: resolved.gateway,
      runner: resolved.runner,
      runtime: resolved.runtime,
      toolHost,
      ...egressProxy,
      apps: appImages,
    },
    // The recovery path re-copies the release sources over a missing state pin, so those verify too.
    signed: new Set([
      ...releaseReferences({ ...resolved, toolHost, ...egressProxy }),
      // `sources` stays lazy: an unpinned CLI would otherwise inspect the ghcr tags on every deploy.
      ...(sources === undefined || !PLATFORM_IMAGES_PINNED ? [] : releaseReferences(sources())),
    ]),
    apply: options.apply,
    tag: PLATFORM_IMAGE_VERSION,
    ownerEmail,
  });
  if (copied === null) return null;
  const { apps: copiedApps = {}, ...platform } = copied;
  return { ...platform, apps: copiedApps };
}

/** The images `render` pins after a copy, and the apps' copied references the module takes. */
export interface CopiedReleaseImages extends DeploymentImages {
  readonly apps: Readonly<Record<string, string>>;
}

/** `env` with each copied image as the `AW_<NAME>_IMAGE` override that makes `render` pin it. */
export function withCopiedImages(
  env: NodeJS.ProcessEnv | undefined,
  copies: DeploymentImages,
): NodeJS.ProcessEnv {
  return {
    ...(env ?? process.env),
    ...Object.fromEntries(
      CLOUD_RUN_IMAGES.map((name) => [`AW_${name.toUpperCase()}_IMAGE`, copies[name]]),
    ),
    ...(copies.egressProxy === undefined ? {} : { AW_EGRESS_PROXY_IMAGE: copies.egressProxy }),
    ...(copies.toolHost === undefined ? {} : { AW_TOOL_HOST_IMAGE: copies.toolHost }),
  };
}

/** `deployed`'s apps, each with the Artifact Registry copy of its image. */
export function copiedApps(
  deployed: ProductionEnvironment,
  copies: CopiedReleaseImages,
): Record<string, ProductionApp> {
  return Object.fromEntries(
    Object.entries(deployed.apps ?? {}).map(([name, app]) => [
      name,
      { ...app, image: copies.apps[name] ?? app.image },
    ]),
  );
}

/**
 * A checkout's module is never written to, so its `apps` variable travels as `TF_VAR_apps`, which
 * ranks below any tfvars file of the Owner's.
 */
export function withCopiedApps(
  env: NodeJS.ProcessEnv,
  deployed: ProductionEnvironment,
  copies: CopiedReleaseImages,
): NodeJS.ProcessEnv {
  const apps = copiedApps(deployed, copies);
  return Object.keys(apps).length === 0
    ? env
    : { ...env, TF_VAR_apps: JSON.stringify(appVariables(apps)) };
}
