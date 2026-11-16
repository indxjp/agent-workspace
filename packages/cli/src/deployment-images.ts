import { DOCKER_COMMAND_TIMEOUT_MS, runDocker } from './deployment-docker.ts';
import { type DeploymentCloud } from './profile.ts';
import {
  PLATFORM_IMAGE_VERSION,
  PLATFORM_IMAGES_WORKFLOW,
  platformImageReference,
} from './release-images.ts';

const digestPattern = /@sha256:[0-9a-f]{64}$/u;

export interface DeploymentImages {
  readonly web: string;
  readonly gateway: string;
  readonly runner: string;
  /**
   * The `claude-agent-sdk` engine's runtime image (ENG-07, ADR-0073), rendered as that engine's
   * entry of the `engine → image` map. Only that engine has an adapter today; a later engine unit
   * widens this to one field per engine.
   */
  readonly runtime: string;
  /**
   * The two services only the Compose project runs. A cloud deployment takes its database and its
   * bucket from the cloud, so a reference set rendered for one carries neither.
   */
  readonly postgres?: string;
  /** The Compose project's S3-compatible object store (ADR-0067). */
  readonly seaweedfs?: string;
  /**
   * The sandbox egress proxy (ADR-0117), which only the `gcp-cloudrun` shape with
   * `gcp.sandboxInternet` pulls: it runs on its own VM beside the Cloud Run services. No other
   * shape resolves it, so `resolveDeploymentImages` leaves it out; `resolveEgressProxyImage`
   * resolves it.
   */
  readonly egressProxy?: string;
  /**
   * The tool-host image, which only the `gcp-cloudrun` shape pulls: its Cloud Run tool host runs
   * it. No shape resolves it from the release inside `resolveDeploymentImages`, which leaves it
   * out unless an `AW_TOOL_HOST_IMAGE` override or a pin supplies one; `resolveToolHostImage`
   * resolves it.
   */
  readonly toolHost?: string;
}

/**
 * The platform references come from `release-images.json`, the one list the image release
 * workflow publishes (#370, ADR-0086); the two Compose-only services are third-party images.
 */
const releaseTags: Required<DeploymentImages> = {
  web: platformImageReference('web'),
  gateway: platformImageReference('gateway'),
  runner: platformImageReference('runner'),
  runtime: platformImageReference('runtime'),
  postgres: 'docker.io/library/postgres:18-alpine',
  // chrislusf/seaweedfs:4.47, pinned by its multi-arch image index digest: the same digest the
  // S3 contract suite runs against (ADR-0066), so what CI proves is what a project pulls.
  seaweedfs:
    'docker.io/chrislusf/seaweedfs@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882',
  egressProxy: platformImageReference('egressProxy'),
  toolHost: platformImageReference('toolHost'),
};

/** The images a deployment pins, named once so every check over them stays exhaustive. */
const IMAGE_NAMES = [
  'web',
  'gateway',
  'runner',
  'runtime',
  'postgres',
  'seaweedfs',
  'egressProxy',
  'toolHost',
] as const;

/**
 * The override this generator read before the bundled object store became SeaweedFS (ADR-0067).
 * It named a MinIO image; honouring it would pin MinIO into a service that now runs `weed`, and
 * ignoring it would silently drop what release engineering asked for, so it is refused by name.
 */
const RETIRED_IMAGE_OVERRIDE = 'AW_MINIO_IMAGE';

export function assertDigestReference(reference: string, name = 'image'): string {
  if (!digestPattern.test(reference) || reference.endsWith(`sha256:${'0'.repeat(64)}`)) {
    throw new Error(`${name} must be a non-placeholder sha256 digest reference`);
  }
  return reference;
}

/**
 * Re-assert the release gate over a whole reference set, whatever produced it. A caller that
 * supplies its own images must clear the same bar as one that let `resolveDeploymentImages` do it,
 * or the gate would have a hole a caller could walk through.
 *
 * The gate covers whatever the set holds: a cloud reference set carries no Compose images, and
 * demanding a pin for an image that deployment never pulls would be a gate on nothing. Every
 * reference that *is* present still has to be a non-placeholder digest.
 */
export function assertDigestReferences(images: DeploymentImages): DeploymentImages {
  for (const name of IMAGE_NAMES) {
    const reference = images[name];
    if (reference !== undefined) assertDigestReference(reference, name);
  }
  return images;
}

function repositoryOf(reference: string): string {
  const lastSlash = reference.lastIndexOf('/');
  const lastColon = reference.lastIndexOf(':');
  return lastColon > lastSlash ? reference.slice(0, lastColon) : reference;
}

/**
 * What an operator can do when a platform image this CLI pins by default cannot be resolved: the
 * usual cause is that the image release for this version has not run, or its packages are not
 * public yet. The generator still refuses; it never writes a project with a mutable tag.
 */
function platformImagesUnavailableHint(): string {
  return (
    `The Agent Workspace platform images for ${PLATFORM_IMAGE_VERSION} are published by ` +
    `${PLATFORM_IMAGES_WORKFLOW} from the tag images-v${PLATFORM_IMAGE_VERSION} on main, and ` +
    'each ghcr.io package must be public for an anonymous pull. If that release has not run yet, ' +
    'set AW_WEB_IMAGE, AW_GATEWAY_IMAGE, AW_RUNNER_IMAGE and AW_RUNTIME_IMAGE to sha256 digest ' +
    'references of images you built, or use a CLI version whose images are published. ' +
    'No project was written.'
  );
}

/**
 * A registry answer that says nothing about the image: the network or the registry failed for a
 * moment (no route, a timeout, a reset or refused connection, a TLS handshake, a DNS miss, a 5xx or
 * 429). A shared CI machine sees these a few times a week, so the lookup tries again before it
 * refuses. A 401, 403 or "not found" is the answer itself and is never retried. An empty stderr
 * (docker exited non-zero and said nothing, as on the 2026-11-12 nightly) carries no refusal, so it
 * is treated as transient too.
 */
const TRANSIENT_REGISTRY_FAILURE =
  /no route to host|i\/o timeout|timed? ?out|connection (?:reset|refused)|tls handshake|temporary failure in name resolution|no such host|unexpected eof|\b(?:429|500|502|503|504)\b|too many requests|bad gateway|service unavailable|gateway timeout|internal server error/iu;

const PERMANENT_REGISTRY_FAILURE =
  /\b(?:401|403|404)\b|unauthori[sz]ed|forbidden|denied|not found|manifest unknown|name unknown/iu;

export function isTransientRegistryFailure(stderr: string): boolean {
  if (stderr.trim() === '') return true;
  return TRANSIENT_REGISTRY_FAILURE.test(stderr) && !PERMANENT_REGISTRY_FAILURE.test(stderr);
}

/** How the digest lookup retries a transient failure: 4 tries, waiting 2, 4 and 8 seconds. */
export const REGISTRY_RETRY = {
  attempts: 4,
  delaysMs: [2_000, 4_000, 8_000] as readonly number[],
  /** Blocks this synchronous lookup for `ms`; replaced by the suite. */
  sleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

function inspectManifest(reference: string) {
  return runDocker(
    ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}'],
    { env: process.env, timeout: DOCKER_COMMAND_TIMEOUT_MS },
  );
}

function resolveTaggedImage(reference: string, releaseDefault = false): string {
  if (reference.includes('@')) return assertDigestReference(reference);
  let result = inspectManifest(reference);
  let attempts = 1;
  // A null status (docker missing, or killed by the timeout) is not retried: it is not the network.
  while (
    result.status !== 0 &&
    result.status !== null &&
    attempts < REGISTRY_RETRY.attempts &&
    isTransientRegistryFailure(result.stderr ?? '')
  ) {
    REGISTRY_RETRY.sleep(REGISTRY_RETRY.delaysMs[attempts - 1] ?? 8_000);
    result = inspectManifest(reference);
    attempts += 1;
  }
  if (result.status !== 0) {
    const cause = result.stderr?.trim() || 'docker buildx failed';
    const tries = attempts > 1 ? ` (after ${attempts} attempts)` : '';
    // A null status means docker never ran to completion (missing or timed out): not the release.
    const hint =
      releaseDefault && result.status !== null ? ` ${platformImagesUnavailableHint()}` : '';
    throw new Error(
      `Could not resolve immutable digest for ${reference}: ${cause}${tries}.${hint}`,
    );
  }
  const digest = manifestDigest(result.stdout);
  if (digest === undefined) throw new Error(`Registry returned no digest for ${reference}`);
  return assertDigestReference(`${repositoryOf(reference)}@${digest}`);
}

function manifestDigest(output: string): string | undefined {
  try {
    const manifest = JSON.parse(output) as { digest?: unknown; Digest?: unknown } | null;
    const digest = manifest?.digest ?? manifest?.Digest;
    return typeof digest === 'string' ? digest : undefined;
  } catch {
    return undefined;
  }
}

/** The override of the egress proxy image; `toUpperCase` of its field name would not spell it. */
const EGRESS_PROXY_OVERRIDE = 'AW_EGRESS_PROXY_IMAGE';
/** The override of the tool-host image, spelled the same way. */
const TOOL_HOST_OVERRIDE = 'AW_TOOL_HOST_IMAGE';

/** The override variable of the images whose name `toUpperCase` would not spell. */
const NAMED_OVERRIDES: Partial<Record<keyof Required<DeploymentImages>, string>> = {
  egressProxy: EGRESS_PROXY_OVERRIDE,
  toolHost: TOOL_HOST_OVERRIDE,
};

/** The override, else the pin, else the release default, of one image, as a digest reference. */
function resolveImage(
  name: keyof Required<DeploymentImages>,
  environment: NodeJS.ProcessEnv,
  pinned: Partial<DeploymentImages>,
): string {
  const named = NAMED_OVERRIDES[name];
  const override =
    named === undefined ? environment[`AW_${name.toUpperCase()}_IMAGE`] : environment[named];
  if (override !== undefined) return resolveTaggedImage(override);
  const pin = pinned[name];
  if (pin !== undefined) return assertDigestReference(pin, `the pinned ${name} image`);
  return resolveTaggedImage(releaseTags[name], name !== 'postgres' && name !== 'seaweedfs');
}

/**
 * Resolve every image the named deployment shape pulls to an immutable digest.
 *
 * `local` runs the Compose project, so it pins PostgreSQL and SeaweedFS too. A cloud deployment
 * takes its database and its bucket from the cloud, so resolving those two would reach a registry
 * for references nothing in that deployment ever pulls.
 *
 * For each image, an `AW_<NAME>_IMAGE` override wins; then a reference already `pinned` (what an
 * existing project's `.env` holds, which `agent-workspace render` passes), held to the same digest
 * gate; then this CLI's release default. A pin is used as it is, without a registry, so
 * re-rendering a project is offline and never upgrades an image the operator did not ask for.
 *
 * `egressProxy` is the exception to "every image the shape pulls": no shape resolves it from the
 * release, because only `gcp.sandboxInternet` pulls it (`resolveEgressProxyImage`). A `gcp` set
 * carries it only when an `AW_EGRESS_PROXY_IMAGE` override or a pin supplies one. `toolHost` is
 * the same: the `gcp-cloudrun` deploy copies it and hands it over as `AW_TOOL_HOST_IMAGE`.
 */
export function resolveDeploymentImages(
  cloud: DeploymentCloud,
  environment: NodeJS.ProcessEnv = process.env,
  pinned: Partial<DeploymentImages> = {},
): DeploymentImages {
  const resolve = (
    name: Exclude<keyof Required<DeploymentImages>, 'egressProxy' | 'toolHost'>,
  ): string => resolveImage(name, environment, pinned);
  // The egress proxy is never resolved from the release here: only a `gcp` run that was handed one
  // (the override a deploy sets once it copied the image, or a pin) carries it on.
  const egressProxy =
    cloud === 'gcp' &&
    (environment[EGRESS_PROXY_OVERRIDE] !== undefined || pinned.egressProxy !== undefined)
      ? { egressProxy: resolveEgressProxyImage(environment, pinned.egressProxy) }
      : {};
  const toolHost =
    cloud === 'gcp' &&
    (environment[TOOL_HOST_OVERRIDE] !== undefined || pinned.toolHost !== undefined)
      ? { toolHost: resolveToolHostImage(environment, pinned.toolHost) }
      : {};
  const platform = {
    web: resolve('web'),
    gateway: resolve('gateway'),
    runner: resolve('runner'),
    runtime: resolve('runtime'),
    ...egressProxy,
    ...toolHost,
  };
  if (cloud !== 'local') return platform;
  if (environment[RETIRED_IMAGE_OVERRIDE] !== undefined) {
    throw new Error(
      `${RETIRED_IMAGE_OVERRIDE} is no longer read: the Compose project's object store is ` +
        'SeaweedFS (ADR-0067). Set AW_SEAWEEDFS_IMAGE to a SeaweedFS digest reference instead.',
    );
  }
  return {
    ...platform,
    postgres: resolve('postgres'),
    seaweedfs: resolve('seaweedfs'),
  };
}

/**
 * Resolve the sandbox egress proxy image, which `resolveDeploymentImages` never does: an
 * `AW_EGRESS_PROXY_IMAGE` override, else the reference already `pinned`, else this CLI's release
 * default, through the same digest gate.
 */
export function resolveEgressProxyImage(
  environment: NodeJS.ProcessEnv = process.env,
  pinned?: string,
): string {
  return resolveImage(
    'egressProxy',
    environment,
    pinned === undefined ? {} : { egressProxy: pinned },
  );
}

/**
 * Resolve the tool-host image, which `resolveDeploymentImages` never does: an
 * `AW_TOOL_HOST_IMAGE` override, else the reference already `pinned`, else this CLI's release
 * default, through the same digest gate.
 */
export function resolveToolHostImage(
  environment: NodeJS.ProcessEnv = process.env,
  pinned?: string,
): string {
  return resolveImage('toolHost', environment, pinned === undefined ? {} : { toolHost: pinned });
}
