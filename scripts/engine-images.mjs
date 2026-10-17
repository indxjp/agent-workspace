#!/usr/bin/env node
/* global console */
/**
 * The engines this repository can build a runtime image for, and the build arguments each one
 * needs (ENG-07, #306; docs/adr/0073-one-runtime-image-per-engine.md).
 *
 * One source of truth for three consumers that must not disagree:
 *
 * - `infra/release/build-and-push.sh` — which images a release publishes;
 * - `.github/workflows/ci.yml` — the matrix, and the per-image-tree licence gate;
 * - `runtime.Dockerfile` — `--verify-label`, which refuses to build an image whose labels would not
 *   describe the manifests that were actually copied into it.
 *
 * ## Derived, not listed
 *
 * The engine list is **derived from the tree**: every `packages/engine-<id>` directory is one
 * engine, `<id>` is its id, and `packages/engine` (the port) is not one. A checked-in list would be
 * a fourth place for `ENGINE_IDS` to fall out of step with reality;
 * `packages/runtime/src/engine-images.test.ts` and `apps/web/server/engines/images.test.ts` hold the
 * derivation to the published catalogue from the other side.
 *
 * Each adapter declares its own third-party SDK under `agentWorkspace.engineSdk` in its manifest.
 * That is the adapter's fact about itself and nothing else can answer it: "the dependency that is
 * not `@agent-workspace/*`" is a guess that breaks the first time an adapter needs a second one.
 *
 * ## Usage
 *
 *     node scripts/engine-images.mjs            # one `id image engine-version` per line
 *     node scripts/engine-images.mjs --json     # the same, as JSON, for a CI matrix
 *     node scripts/engine-images.mjs --verify-label <engine> <engine-version>
 *     node scripts/engine-images.mjs --verify-image <image> <engine> <engine-version>
 *
 * `--verify-image` is the image build test CI runs on every image it builds: the two labels must
 * say `<engine>` and `<engine-version>`, and the image's `/srv/packages` must hold exactly one
 * adapter, `engine-<engine>`, beside the port. It is what enforces the hypothesis the Lean model
 * (`formal/AgentWorkspace/Behaviour/EngineImages.lean`) states and cannot prove: that an image's
 * `io.agent-workspace.engine` label describes what the image contains.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The image repository one engine's runtime image is published under.
 * @param {string} engineId
 */
export function engineImageName(engineId) {
  return `runtime-${engineId}`;
}

/** @param {string} file */
function readManifest(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`ENGINE_MANIFEST_UNREADABLE: ${file}: ${String(error)}`, { cause: error });
  }
}

/**
 * The `<adapter>+<sdk>` string one engine's `io.agent-workspace.engine-version` label carries.
 *
 * Throws rather than falling back: an adapter that declares no `agentWorkspace.engineSdk`, or one
 * whose declared SDK is not among its dependencies, cannot be labelled honestly, and an image
 * labelled with a guess is worse than one that failed to build.
 * @param {string} engineId @param {any} manifest A parsed `package.json`.
 * @returns {{ engineSdk: string, engineVersion: string }}
 */
export function engineVersionFor(engineId, manifest) {
  const sdk = manifest.agentWorkspace?.engineSdk;
  if (typeof sdk !== 'string' || sdk.length === 0) {
    throw new Error(
      `ENGINE_SDK_UNDECLARED: packages/engine-${engineId}/package.json must declare agentWorkspace.engineSdk (the third-party SDK this adapter wraps).`,
    );
  }
  const sdkVersion = manifest.dependencies?.[sdk];
  if (typeof sdkVersion !== 'string' || sdkVersion.length === 0) {
    throw new Error(
      `ENGINE_SDK_NOT_A_DEPENDENCY: packages/engine-${engineId} declares agentWorkspace.engineSdk ${JSON.stringify(sdk)} but does not depend on it.`,
    );
  }
  const version = manifest.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(
      `ENGINE_VERSION_MISSING: packages/engine-${engineId}/package.json has no version.`,
    );
  }
  return { engineSdk: sdk, engineVersion: `${version}+${sdkVersion}` };
}

/**
 * Every engine with an adapter package in a tree (this repository by default), in id order.
 *
 * @param {string} [root]
 * @returns {{ id: string, image: string, engineVersion: string, engineSdk: string }[]}
 */
export function engineImages(root = REPOSITORY_ROOT) {
  const PACKAGES = path.join(root, 'packages');
  if (!existsSync(PACKAGES)) return [];
  const directories = readdirSync(PACKAGES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('engine-'))
    .map((entry) => entry.name)
    .sort();
  return directories.map((directory) => {
    const id = directory.slice('engine-'.length);
    const manifest = readManifest(path.join(PACKAGES, directory, 'package.json'));
    if (manifest.name !== `@agent-workspace/engine-${id}`) {
      throw new Error(
        `ENGINE_PACKAGE_MISNAMED: packages/${directory} is named ${JSON.stringify(manifest.name)}; an adapter package directory must be packages/engine-<engine id>.`,
      );
    }
    const { engineSdk, engineVersion } = engineVersionFor(id, manifest);
    return { id, image: engineImageName(id), engineVersion, engineSdk };
  });
}

/**
 * The `runtime.Dockerfile` build-time check: do the arguments describe the manifest that was
 * actually copied into this build?
 *
 * Run from the build context's working directory, where only the selected engine's package exists.
 * @param {string} engineId @param {string} engineVersion
 */
function verifyLabel(engineId, engineVersion) {
  const manifest = readManifest(
    path.join(process.cwd(), 'packages', `engine-${engineId}`, 'package.json'),
  );
  if (manifest.name !== `@agent-workspace/engine-${engineId}`) {
    throw new Error(
      `ENGINE_PACKAGE_MISNAMED: packages/engine-${engineId} is named ${JSON.stringify(manifest.name)}.`,
    );
  }
  const actual = engineVersionFor(engineId, manifest).engineVersion;
  if (actual !== engineVersion) {
    throw new Error(
      `ENGINE_LABEL_MISMATCH: ENGINE_VERSION is ${JSON.stringify(engineVersion)} but the copied manifests say ${JSON.stringify(actual)}. Run \`node scripts/engine-images.mjs\` for the right build arguments.`,
    );
  }
  return `engine ${engineId} at ${actual}`;
}

/**
 * The CI image build test: labels and contents of one built image.
 *
 * @param {string} image
 * @param {string} engineId
 * @param {string} engineVersion
 */
function verifyImage(image, engineId, engineVersion) {
  const labels = JSON.parse(
    execFileSync('docker', ['image', 'inspect', '--format', '{{json .Config.Labels}}', image], {
      encoding: 'utf8',
    }),
  );
  if (labels?.['io.agent-workspace.engine'] !== engineId) {
    throw new Error(
      `ENGINE_IMAGE_LABEL_MISMATCH: ${image} is labelled io.agent-workspace.engine=${JSON.stringify(labels?.['io.agent-workspace.engine'])}, expected ${JSON.stringify(engineId)}.`,
    );
  }
  if (labels?.['io.agent-workspace.engine-version'] !== engineVersion) {
    throw new Error(
      `ENGINE_IMAGE_LABEL_MISMATCH: ${image} is labelled io.agent-workspace.engine-version=${JSON.stringify(labels?.['io.agent-workspace.engine-version'])}, expected ${JSON.stringify(engineVersion)}.`,
    );
  }
  const packages = execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'node',
      image,
      '-e',
      "console.log(require('node:fs').readdirSync('/srv/packages').join(' '))",
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split(' ')
    .filter((name) => name.startsWith('engine-'));
  if (packages.length !== 1 || packages[0] !== `engine-${engineId}`) {
    throw new Error(
      `ENGINE_IMAGE_CONTENTS_MISMATCH: ${image} carries adapters [${packages.join(', ')}]; it must carry exactly engine-${engineId}.`,
    );
  }
  return `image ${image} carries exactly engine ${engineId} at ${engineVersion}`;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    const imageAt = process.argv.indexOf('--verify-image');
    const verifyAt = process.argv.indexOf('--verify-label');
    if (imageAt !== -1) {
      const [image, engineId, engineVersion] = process.argv.slice(imageAt + 1, imageAt + 4);
      if (!image || !engineId || !engineVersion) {
        throw new Error(
          'usage: engine-images.mjs --verify-image <image> <engine> <engine-version>',
        );
      }
      console.log(verifyImage(image, engineId, engineVersion));
    } else if (verifyAt !== -1) {
      const engineId = process.argv[verifyAt + 1];
      const engineVersion = process.argv[verifyAt + 2];
      if (!engineId || !engineVersion) {
        throw new Error('usage: engine-images.mjs --verify-label <engine> <engine-version>');
      }
      console.log(verifyLabel(engineId, engineVersion));
    } else if (process.argv.includes('--json')) {
      console.log(JSON.stringify(engineImages()));
    } else {
      for (const entry of engineImages()) {
        console.log(`${entry.id} ${entry.image} ${entry.engineVersion}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
