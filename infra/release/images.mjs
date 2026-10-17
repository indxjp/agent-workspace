#!/usr/bin/env node
/**
 * The platform image release plan (#370, ADR-0086): every image an `images-v<version>` tag builds,
 * signs and pushes, with the Dockerfile and target that builds it.
 *
 * ## One source of truth
 *
 * `packages/cli/src/release-images.json` names the registry, the version and the images the
 * generator pins (`create`, `render` and the Compose templates). This module reads that document
 * and adds the one thing it cannot know: the runtime image of every engine with an adapter package
 * (ADR-0073), derived from the tree by `scripts/engine-images.mjs`. Nothing here restates an image
 * name, so the generator and the workflow cannot disagree; `tests/release/platform-images.test.ts`
 * holds the plan to both inputs.
 *
 * ## Usage
 *
 *     node infra/release/images.mjs              # one `name dockerfile target engine engine-version` per line
 *     node infra/release/images.mjs --json       # the plan as JSON
 *     node infra/release/images.mjs --registry   # the registry, e.g. ghcr.io/indxdev
 *     node infra/release/images.mjs --version    # the version the images are tagged with
 *     node infra/release/images.mjs --references # one `<registry>/agent-workspace/<name>:<version>` per line
 *
 * `engine` and `engine-version` are `-` for an image that is not a runtime image.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { engineImages } from '../../scripts/engine-images.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RELEASE_IMAGES_FILE = 'packages/cli/src/release-images.json';
export const IMAGE_NAMESPACE = 'agent-workspace';
/** The same version grammar `packages/cli/src/release-images.ts` enforces for the CLI. */
export const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

/**
 * How each non-runtime generator field is built. Never build `Dockerfile` without `--target`: its
 * final stage is an implementation detail, not a process contract.
 */
const PROCESS_TARGETS = {
  web: { dockerfile: 'Dockerfile', target: 'web' },
  gateway: { dockerfile: 'gateway.Dockerfile', target: 'gateway' },
  runner: { dockerfile: 'Dockerfile', target: 'runner' },
};

/**
 * Images the platform publishes that the generator does not pin: nothing resolves them through
 * `create` yet. They are built, scanned, signed and recorded in the release manifest like the rest.
 */
const PLATFORM_ONLY_IMAGES = [
  { name: 'egress-proxy', dockerfile: 'egress-proxy.Dockerfile', target: 'egress-proxy' },
  { name: 'tool-host', dockerfile: 'tool-host.Dockerfile', target: 'tool-host' },
];

/** @param {string} [root] */
export function readReleaseImages(root = REPOSITORY_ROOT) {
  const document = JSON.parse(readFileSync(path.join(root, RELEASE_IMAGES_FILE), 'utf8'));
  const { registry, version, images } = document ?? {};
  if (
    typeof registry !== 'string' ||
    typeof version !== 'string' ||
    typeof images !== 'object' ||
    images === null ||
    Array.isArray(images)
  ) {
    throw new Error(`${RELEASE_IMAGES_FILE} must name a registry, a version and images`);
  }
  // The version becomes every image's tag and the images-v<version> tag the workflow requires.
  if (!VERSION.test(version)) {
    throw new Error(`${RELEASE_IMAGES_FILE} version ${version} is not a semantic version`);
  }
  return { registry, version, images };
}

/**
 * The build plan, in publish order: the generator's process images, the platform-only images, then
 * one runtime image per engine. Throws when the generator pins an image the plan would not build.
 *
 * @param {string} [root]
 * @returns {{ name: string, dockerfile: string, target: string, engine: string | null, engineVersion: string | null }[]}
 */
export function releasePlan(root = REPOSITORY_ROOT) {
  const { images } = readReleaseImages(root);
  const plan = [];
  for (const [field, build] of Object.entries(PROCESS_TARGETS)) {
    const name = images[field];
    if (typeof name !== 'string') {
      throw new Error(`${RELEASE_IMAGES_FILE} must name the ${field} image`);
    }
    plan.push({ name, ...build, engine: null, engineVersion: null });
  }
  for (const image of PLATFORM_ONLY_IMAGES) {
    plan.push({ ...image, engine: null, engineVersion: null });
  }
  for (const engine of engineImages(root)) {
    plan.push({
      name: engine.image,
      dockerfile: 'runtime.Dockerfile',
      target: 'runtime',
      engine: engine.id,
      engineVersion: engine.engineVersion,
    });
  }
  const planned = new Set(plan.map((image) => image.name));
  for (const [field, name] of Object.entries(images)) {
    if (!planned.has(name)) {
      throw new Error(
        `RELEASE_IMAGE_UNBUILT: ${RELEASE_IMAGES_FILE} pins ${field}=${String(name)}, which no Dockerfile target or engine adapter builds.`,
      );
    }
  }
  if (planned.size !== plan.length)
    throw new Error('RELEASE_IMAGE_DUPLICATE: an image is planned twice');
  return plan;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    const { registry, version } = readReleaseImages();
    const plan = releasePlan();
    const flag = process.argv[2];
    if (flag === '--json') {
      process.stdout.write(`${JSON.stringify({ registry, version, images: plan })}\n`);
    } else if (flag === '--registry') {
      process.stdout.write(`${registry}\n`);
    } else if (flag === '--version') {
      process.stdout.write(`${version}\n`);
    } else if (flag === '--references') {
      for (const image of plan) {
        process.stdout.write(`${registry}/${IMAGE_NAMESPACE}/${image.name}:${version}\n`);
      }
    } else if (flag === undefined) {
      for (const image of plan) {
        const engine = image.engine ?? '-';
        const engineVersion = image.engineVersion ?? '-';
        process.stdout.write(
          `${image.name} ${image.dockerfile} ${image.target} ${engine} ${engineVersion}\n`,
        );
      }
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
