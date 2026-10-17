/**
 * The platform images a generated project pins, built from this checkout for the generated-project
 * E2E (`run.mjs`) and pushed to a throwaway registry on the Docker host, so that the project runs
 * this change's web, gateway, runner and runtime rather than the published ones.
 *
 * Nothing here names an image: the generator's own list (`packages/cli/src/release-images.json`,
 * read through `infra/release/images.mjs`) says which images a project pins and the release plan
 * says how each is built, so this test builds exactly what an `images-v*` release would publish for
 * those fields, one platform only. The result is the four `AW_*_IMAGE` overrides the generator
 * already reads (`packages/cli/src/deployment.ts`): each a tag in the throwaway registry, which
 * `create` resolves to a digest the way it resolves a release tag. The production default is
 * untouched.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { IMAGE_NAMESPACE, readReleaseImages, releasePlan } from '../../infra/release/images.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The generator fields this test builds, in the order the overrides are named. */
export const PINNED_FIELDS = ['web', 'gateway', 'runner', 'runtime'];

/** The tag every locally built image carries in the throwaway registry. */
export const LOCAL_TAG = 'e2e';

/**
 * The builds the generator's pinned images need: each field's release-plan entry, with the
 * reference it is pushed under and the `AW_*_IMAGE` variable that hands it to `create`.
 *
 * @param {string} registry e.g. `localhost:5000`
 * @param {string} [root]
 */
export function pinnedImageBuilds(registry, root = REPOSITORY_ROOT) {
  const { images } = readReleaseImages(root);
  const plan = releasePlan(root);
  return PINNED_FIELDS.map((field) => {
    const name = images[field];
    const entry = plan.find((image) => image.name === name);
    if (entry === undefined) {
      throw new Error(
        `release-images.json pins ${field}=${String(name)}, which no plan entry builds`,
      );
    }
    return {
      field,
      variable: `AW_${field.toUpperCase()}_IMAGE`,
      reference: `${registry}/${IMAGE_NAMESPACE}/${entry.name}:${LOCAL_TAG}`,
      dockerfile: entry.dockerfile,
      target: entry.target,
      buildArgs:
        entry.engine === null
          ? {}
          : { ENGINE: entry.engine, ENGINE_VERSION: String(entry.engineVersion) },
    };
  });
}

/**
 * Milliseconds left before `deadline`; throws once it has passed, so that a slow preparation fails
 * with a message instead of running into the job's timeout.
 *
 * @param {number} deadline epoch milliseconds
 */
export function remainingBefore(deadline, now = Date.now()) {
  const left = deadline - now;
  if (!Number.isFinite(left)) {
    throw new Error(`the preparation deadline is not a finite time (${String(deadline)})`);
  }
  if (left <= 0) throw new Error('the generated-project preparation budget is spent');
  return left;
}

/** @param {readonly string[]} args @param {number} timeoutMs */
function docker(args, timeoutMs) {
  const result = spawnSync('docker', args, {
    cwd: REPOSITORY_ROOT,
    stdio: 'inherit',
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
  });
  if (result.error !== undefined || result.status !== 0) {
    const cause = result.error?.message ?? `exit ${String(result.status ?? result.signal)}`;
    throw new Error(`docker ${args.slice(0, 2).join(' ')} failed (${cause})`);
  }
}

/**
 * Build and push every pinned image; returns the `AW_*_IMAGE` overrides. With `push: false` the
 * images are only built (into the Docker host's image store and build cache), which is what
 * `--warm` below does.
 *
 * @param {{ registry: string, revision: string, deadline: number, platform?: string, push?: boolean }} options
 * @returns {Record<string, string>}
 */
export function buildPinnedImages({
  registry,
  revision,
  deadline,
  platform = 'linux/amd64',
  push = true,
}) {
  /** @type {Record<string, string>} */
  const overrides = {};
  for (const build of pinnedImageBuilds(registry)) {
    const args = [
      'buildx',
      'build',
      '--platform',
      platform,
      '--file',
      build.dockerfile,
      '--target',
      build.target,
      '--build-arg',
      `VCS_REF=${revision}`,
      '--label',
      `org.opencontainers.image.revision=${revision}`,
      '--tag',
      build.reference,
      ...(push ? ['--push'] : []),
    ];
    for (const [key, value] of Object.entries(build.buildArgs)) {
      args.push('--build-arg', `${key}=${value}`);
    }
    process.stdout.write(`building ${build.field}: ${build.reference}\n`);
    docker([...args, '.'], remainingBefore(deadline));
    overrides[build.variable] = build.reference;
  }
  return overrides;
}

/** `git rev-parse HEAD` of this checkout, the revision run.mjs builds with by default. */
export function checkoutRevision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

// `node tests/generated-project/images.mjs --warm`: build the pinned images with exactly the
// arguments run.mjs uses, without a registry, so that run.mjs's own builds are build-cache hits.
// CI runs it while the published packages are still being built (ci.yml generated-project-e2e).
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.slice(2).join(' ') !== '--warm') {
    process.stderr.write('usage: node tests/generated-project/images.mjs --warm\n');
    process.exit(2);
  }
  buildPinnedImages({
    registry: `localhost:${process.env['GP_REGISTRY_PORT'] ?? '5000'}`,
    revision: process.env['GP_REVISION'] ?? checkoutRevision(),
    deadline: Date.now() + 30 * 60_000,
    push: false,
  });
}
