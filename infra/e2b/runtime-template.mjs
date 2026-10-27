/**
 * The E2B build definition of the runtime template, derived from `runtime.Dockerfile` so a template
 * can be built from a checkout instead of a published image (issue #827). The released image is the
 * runtime of the last release; a journey that proves a commit must run that commit's runner, so the
 * Dockerfile's `build` and `runtime` stages are replayed inside one template, as the tool-host
 * template does (`tool-host-template.mjs`, whose wire-format notes apply here too).
 *
 * The base image, engine, engine version, pnpm version and pnpm tarball checksum are read from the
 * Dockerfile; `tests/release/e2b-template.test.ts` holds the COPY paths and commands to it. The
 * differences from the image: the whole of each copied path is in `/srv` (the image keeps only the
 * built runner and its production tree), and the image `LABEL`s have no template equivalent.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILD_ENV, contextArchive } from './tool-host-template.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DOCKERFILE = 'runtime.Dockerfile';
/** The runtime's directory in the template: `runtime.Dockerfile` builds and runs in `/srv`. */
export const SRV_DIR = '/srv';
/** `runtime.Dockerfile`'s `WORKDIR` and the working directory of a run. */
export const WORKSPACE_DIR = '/workspace';
/** What the Dockerfile's `COPY` instructions take from the context, with `ENGINE` substituted. */
export const contextPaths = (/** @type {string} */ engine) => [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  'tsconfig.json',
  'apps/runner',
  'packages/contracts',
  'packages/core',
  'packages/engine',
  `packages/engine-${engine}`,
  'packages/run-protocol',
  'packages/runtime',
  'scripts/engine-images.mjs',
  'infra/images/npx.mjs',
  'infra/images/npx-run-bin.mjs',
  'LICENSE',
];
/** The Dockerfile's final-stage `ENV`s; `PNPM_CLI` is where its pnpm tarball is unpacked. */
export const RUN_ENV = [
  'NODE_ENV',
  'production',
  'HOST',
  '0.0.0.0',
  'PORT',
  '8080',
  'PNPM_CLI',
  '/opt/pnpm/bin/pnpm.cjs',
];
/**
 * The Dockerfile's final-stage OS upgrade and removal of the package managers (ADR-0087). The
 * corepack `pnpm` shims go too: the pnpm install below writes `/usr/local/bin/pnpm`, which would
 * otherwise write through a link into the removed corepack directory.
 */
export const STRIP_COMMAND =
  'apt-get update && apt-get -o Dpkg::Options::=--force-confold upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/* && rm -rf /usr/local/lib/node_modules /opt/yarn-v* /root/.npm /root/.cache /root/.local/share/pnpm /pnpm && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx';
/** The Dockerfile's final-stage `chown`/`mkdir`: the runner runs as `node` and writes only `/workspace`. */
export const OWNER_COMMAND = `mkdir -p ${WORKSPACE_DIR} && chown -R node:node ${SRV_DIR} ${WORKSPACE_DIR}`;

const FILTERS = (/** @type {string} */ engine) =>
  `--filter "@agent-workspace/runner..." --filter "@agent-workspace/engine-${engine}..."`;
// Low concurrency keeps the install's peak memory down: the tool host's was OOM-killed in the E2B builder.
export const installCommand = (/** @type {string} */ engine) =>
  `pnpm install --frozen-lockfile --network-concurrency=4 --child-concurrency=1 ${FILTERS(engine)}`;
export const buildCommand = (/** @type {string} */ engine) => `pnpm ${FILTERS(engine)} build`;
export const verifyLabelCommand = (/** @type {string} */ engine, /** @type {string} */ version) =>
  `node scripts/engine-images.mjs --verify-label "${engine}" "${version}"`;
export const pruneCommand = (/** @type {string} */ engine) =>
  `find . -name node_modules -type d -prune -exec rm -rf {} + && pnpm install --frozen-lockfile --prod --offline ${FILTERS(engine)}`;
export const linkCommand = (/** @type {string} */ engine) =>
  `mkdir -p apps/runner/node_modules/@agent-workspace && ln -sfn ../../../../packages/engine-${engine} apps/runner/node_modules/@agent-workspace/engine-${engine} && cd apps/runner && node --input-type=module -e "await import('@agent-workspace/engine-${engine}')"`;
/** `ADD --checksum=sha256:… <registry tarball>`, as a fetch that fails closed on a mismatch (the base image has no curl). */
export const pnpmFetchCommand = (/** @type {string} */ version, /** @type {string} */ sha256) =>
  `node --input-type=module -e "import{createHash}from'node:crypto';import{writeFileSync}from'node:fs';const r=await fetch('https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz');if(!r.ok)throw new Error('pnpm tarball '+r.status);const b=Buffer.from(await r.arrayBuffer());if(createHash('sha256').update(b).digest('hex')!=='${sha256}')throw new Error('pnpm tarball checksum mismatch');writeFileSync('/tmp/pnpm.tgz',b)"`;
/** The Dockerfile's pnpm and `npx` install into the final stage. */
export const pnpmInstallCommand = `mkdir -p /opt/npx /opt/pnpm && cp ${SRV_DIR}/infra/images/npx.mjs ${SRV_DIR}/infra/images/npx-run-bin.mjs /opt/npx/ && tar -xzf /tmp/pnpm.tgz -C /opt/pnpm --strip-components=1 --no-same-owner && rm -f /tmp/pnpm.tgz && printf '#!/bin/sh\\nexec /usr/local/bin/node /opt/pnpm/bin/pnpm.cjs "$@"\\n' > /usr/local/bin/pnpm && printf '#!/bin/sh\\nexec /usr/local/bin/node /opt/npx/npx.mjs "$@"\\n' > /usr/local/bin/npx && chmod 0755 /usr/local/bin/pnpm /usr/local/bin/npx && ln -s /usr/local/bin/npx /usr/bin/npx && pnpm --version`;

/** The Dockerfile's `ARG name=value` default, refused when it is not a plain token (it is put in a shell command). */
function argOf(/** @type {string} */ dockerfile, /** @type {string} */ name) {
  const value = new RegExp(`^ARG ${name}=(\\S+)$`, 'mu').exec(dockerfile)?.[1];
  if (value === undefined || !/^[A-Za-z0-9_.:@+-]+$/u.test(value)) {
    throw new Error(`${DOCKERFILE} has no usable ARG ${name}`);
  }
  return value;
}

/** @param {string} [root] */
export function runtimeBuild(root = REPOSITORY_ROOT) {
  const dockerfile = readFileSync(path.join(root, DOCKERFILE), 'utf8');
  const image = argOf(dockerfile, 'NODE_IMAGE');
  const engine = argOf(dockerfile, 'ENGINE');
  const engineVersion = argOf(dockerfile, 'ENGINE_VERSION');
  const pnpmVersion = argOf(dockerfile, 'PNPM_VERSION');
  const pnpmSha256 = argOf(dockerfile, 'PNPM_TARBALL_SHA256');
  if (!/^[0-9a-f]{64}$/u.test(pnpmSha256)) throw new Error(`${DOCKERFILE} has no SHA-256 for pnpm`);
  const pnpm = /corepack prepare pnpm@(\S+) --activate/u.exec(dockerfile)?.[1];
  if (pnpm === undefined) throw new Error(`${DOCKERFILE} names no pnpm version`);

  const upload = contextArchive(root, contextPaths(engine), SRV_DIR);

  return {
    image,
    steps: [
      { type: 'USER', args: ['root'] },
      { type: 'WORKDIR', args: ['/'] },
      { type: 'ENV', args: BUILD_ENV },
      { type: 'COPY', args: ['.', SRV_DIR, '', ''], filesHash: upload.hash },
      { type: 'WORKDIR', args: [SRV_DIR] },
      {
        type: 'RUN',
        args: [`corepack enable && corepack prepare pnpm@${pnpm} --activate`, 'root'],
      },
      { type: 'RUN', args: [`${installCommand(engine)} && ${buildCommand(engine)}`, 'root'] },
      { type: 'RUN', args: [verifyLabelCommand(engine, engineVersion), 'root'] },
      { type: 'RUN', args: [pruneCommand(engine), 'root'] },
      { type: 'RUN', args: [linkCommand(engine), 'root'] },
      { type: 'RUN', args: [STRIP_COMMAND, 'root'] },
      { type: 'RUN', args: [pnpmFetchCommand(pnpmVersion, pnpmSha256), 'root'] },
      { type: 'RUN', args: [pnpmInstallCommand, 'root'] },
      { type: 'RUN', args: [OWNER_COMMAND, 'root'] },
      { type: 'ENV', args: RUN_ENV },
      { type: 'WORKDIR', args: [WORKSPACE_DIR] },
      { type: 'USER', args: ['node'] },
    ],
    uploads: [upload],
  };
}
