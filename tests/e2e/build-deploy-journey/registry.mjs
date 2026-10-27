/**
 * The images the build-to-deploy journey deploys, built from this checkout and pushed to a
 * throwaway registry on the Docker host (the generated-project E2E's approach, `images.mjs`).
 *
 * `buildPinnedImages` builds the four images `aw deploy` pins (web, gateway, runner, runtime) and
 * returns the `AW_*_IMAGE` overrides `aw deploy` reads. The tool host and the egress proxy are not
 * pinned by the CLI's single-vm template, so they are built here too and handed to the Compose
 * override as digest references, which the runner demands under `NODE_ENV=production`.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { IMAGE_NAMESPACE, releasePlan } from '../../../infra/release/images.mjs';
import { buildPinnedImages, LOCAL_TAG, remainingBefore } from '../../generated-project/images.mjs';
import { run } from '../../generated-project/project.mjs';
import { REGISTRY_IMAGE } from '../../generated-project/run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// Named per runner: the self-hosted CI host runs several jobs on one Docker daemon at once.
const REGISTRY_CONTAINER = `build-deploy-journey-registry-${(process.env.RUNNER_NAME ?? 'local').replace(/[^\w.-]/gu, '-')}`;
const SANDBOX_IMAGES = ['tool-host', 'egress-proxy'];

/** @param {number} port */
export function startRegistry(port) {
  stopRegistry();
  run('docker', [
    'run',
    '--detach',
    '--name',
    REGISTRY_CONTAINER,
    '--publish',
    `127.0.0.1:${String(port)}:5000`,
    REGISTRY_IMAGE,
  ]);
}

export function stopRegistry() {
  spawnSync('docker', ['rm', '--force', '--volumes', REGISTRY_CONTAINER], { stdio: 'ignore' });
}

/** @param {string} reference a tag in the registry; returns `repository@sha256:<digest>` */
export function digestReference(reference) {
  const manifest = JSON.parse(
    run('docker', ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}']),
  );
  const digest = /** @type {unknown} */ (manifest?.digest);
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new Error(`${reference} has no sha256 digest in the registry`);
  }
  return `${reference.replace(/:[^:/]+$/u, '')}@${digest}`;
}

/**
 * Build and push everything the deployment runs.
 *
 * @param {{ registry: string, revision: string, deadline: number }} options
 * @returns {{ overrides: Record<string, string>, toolHost: string, egressProxy: string }}
 */
export function buildJourneyImages({ registry, revision, deadline }) {
  const overrides = buildPinnedImages({ registry, revision, deadline });
  /** @type {Record<string, string>} */
  const digests = {};
  for (const name of SANDBOX_IMAGES) {
    const entry = releasePlan(ROOT).find((image) => image.name === name);
    if (entry === undefined) throw new Error(`the release plan builds no ${name} image`);
    const reference = `${registry}/${IMAGE_NAMESPACE}/${name}:${LOCAL_TAG}`;
    process.stdout.write(`building ${name}: ${reference}\n`);
    run(
      'docker',
      [
        'buildx',
        'build',
        '--platform',
        'linux/amd64',
        '--file',
        entry.dockerfile,
        '--target',
        entry.target,
        '--build-arg',
        `VCS_REF=${revision}`,
        '--tag',
        reference,
        '--push',
        '.',
      ],
      { cwd: ROOT, timeoutMs: remainingBefore(deadline) },
    );
    digests[name] = digestReference(reference);
  }
  return {
    overrides,
    toolHost: digests['tool-host'] ?? '',
    egressProxy: digests['egress-proxy'] ?? '',
  };
}
