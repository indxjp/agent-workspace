/**
 * The platform images this generator pins, read from `release-images.json` beside this file.
 *
 * That JSON document is the one source of truth for the image list (#370, ADR-0086). Two consumers
 * read it and must not disagree:
 *
 * - this package, which resolves `<registry>/agent-workspace/<name>:<version>` to a digest for
 *   every project `create` writes;
 * - `infra/release/images.mjs`, which turns it into the build plan `infra/release/build-and-push.sh`
 *   publishes from an `images-v<version>` tag (`.github/workflows/images.yml`), adding the runtime
 *   image of every other engine (ADR-0073).
 *
 * It is JSON rather than TypeScript so that the release tooling reads it without a build, and it
 * lives under `src/` so that `tsc` copies it into `dist/` and the published CLI carries it.
 * `tests/release/platform-images.test.ts` holds the two consumers to it.
 */
import document from './release-images.json' with { type: 'json' };

/** The `DeploymentImages` fields the platform release publishes, in build order. */
const PLATFORM_IMAGE_FIELDS = [
  'web',
  'gateway',
  'runner',
  'runtime',
  'egressProxy',
  'toolHost',
] as const;
type PlatformImageField = (typeof PLATFORM_IMAGE_FIELDS)[number];

/** The namespace every platform image is published under, inside the registry. */
const IMAGE_NAMESPACE = 'agent-workspace';

/** The workflow that publishes the images, named in the generator's refusal. */
export const PLATFORM_IMAGES_WORKFLOW = '.github/workflows/images.yml';

interface PlatformImageRelease {
  readonly registry: string;
  readonly version: string;
  readonly images: Readonly<Record<PlatformImageField, string>>;
  /** The digest of each image, written at publish time; absent in a source checkout. */
  readonly digests?: Readonly<Record<PlatformImageField, string>>;
}

const REGISTRY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const IMAGE_NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;

/** The `digests` object: all six fields, each a non-placeholder sha256 digest. */
function parseDigests(value: unknown): Record<PlatformImageField, string> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('release-images.json: digests must map each image field to a digest');
  }
  const digests = value as Record<string, unknown>;
  const unexpected = Object.keys(digests).filter(
    (field) => !(PLATFORM_IMAGE_FIELDS as readonly string[]).includes(field),
  );
  if (unexpected.length > 0) {
    throw new Error(`release-images.json: unexpected digest fields ${unexpected.join(', ')}`);
  }
  const parsed = {} as Record<PlatformImageField, string>;
  for (const field of PLATFORM_IMAGE_FIELDS) {
    const digest = digests[field];
    if (typeof digest !== 'string' || !IMAGE_DIGEST.test(digest) || /^sha256:0+$/u.test(digest)) {
      throw new Error(
        `release-images.json: digests.${field} must be a non-placeholder sha256 digest`,
      );
    }
    parsed[field] = digest;
  }
  return parsed;
}

/**
 * Validate the document's shape. It ships inside the package, so a malformed copy is a packaging
 * bug; refusing it here keeps a bad reference from ever reaching a registry lookup.
 */
export function parseRelease(value: unknown): PlatformImageRelease {
  if (typeof value !== 'object' || value === null) {
    throw new Error('release-images.json must be an object');
  }
  const { registry, version, images, digests } = value as Record<string, unknown>;
  if (typeof registry !== 'string' || !REGISTRY.test(registry)) {
    throw new Error('release-images.json: registry must be a registry host and path');
  }
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error('release-images.json: version must be a semantic version');
  }
  if (typeof images !== 'object' || images === null) {
    throw new Error('release-images.json: images must map each image field to a name');
  }
  const names = images as Record<string, unknown>;
  const unexpected = Object.keys(names).filter(
    (field) => !(PLATFORM_IMAGE_FIELDS as readonly string[]).includes(field),
  );
  if (unexpected.length > 0) {
    throw new Error(`release-images.json: unexpected image fields ${unexpected.join(', ')}`);
  }
  const parsed = {} as Record<PlatformImageField, string>;
  for (const field of PLATFORM_IMAGE_FIELDS) {
    const name = names[field];
    if (typeof name !== 'string' || !IMAGE_NAME.test(name)) {
      throw new Error(`release-images.json: images.${field} must be an image name`);
    }
    parsed[field] = name;
  }
  return {
    registry,
    version,
    images: parsed,
    ...(digests === undefined ? {} : { digests: parseDigests(digests) }),
  };
}

const release = parseRelease(document);

/** Whether this CLI release pins every platform image by digest (a published CLI does). */
export const PLATFORM_IMAGES_PINNED = release.digests !== undefined;

/**
 * The identity `images.yml` signs the platform images with: that workflow, on an `images-v*` tag
 * (not a `v*` tag), through GitHub's OIDC issuer.
 */
export const PLATFORM_IMAGE_SIGNER = {
  identityRegexp:
    '^https://github\\.com/indxjp/agent-workspace/\\.github/workflows/images\\.yml@refs/tags/images-v',
  issuer: 'https://token.actions.githubusercontent.com',
} as const;

/** The version tag every platform image this generator pins carries. */
export const PLATFORM_IMAGE_VERSION = release.version;

/** The tagged reference one platform image is resolved from, e.g. `ghcr.io/…/web:0.1.0`. */
export function platformImageTag(field: PlatformImageField): string {
  return `${release.registry}/${IMAGE_NAMESPACE}/${release.images[field]}:${release.version}`;
}

/** The digest reference of a pinned release, else the tagged reference (a source checkout). */
export function platformImageReference(field: PlatformImageField): string {
  const digest = release.digests?.[field];
  return digest === undefined
    ? platformImageTag(field)
    : `${release.registry}/${IMAGE_NAMESPACE}/${release.images[field]}@${digest}`;
}
