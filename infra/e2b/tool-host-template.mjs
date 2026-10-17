/**
 * The E2B build definition of the tool-host template, derived from `tool-host.Dockerfile` so it can
 * be built without a published registry image (issue #827). E2B builds a template from a base image
 * plus `COPY`/`RUN` steps and cannot run a multi-stage Dockerfile, so the Dockerfile's `build` stage
 * is replayed inside the template: the base image and the pnpm version are read from the Dockerfile,
 * and `tests/release/e2b-template.test.ts` holds the COPY paths and commands to it.
 *
 * The steps use the wire format of the E2B SDK's `Template.fromDockerfile` (checked 2026-10-10,
 * `packages/js-sdk/src/template/{index,dockerfileParser}.ts`): it opens with `USER root` and
 * `WORKDIR /`, an `ENV` step carries `[key, value, …]`, and `COPY` is `[src, dest, user, mode]`.
 *
 * The build context is the git-tracked files of the packages the Dockerfile copies, as one
 * deterministic `tar.gz`; its sha256 is the `filesHash` E2B stores the upload under.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DOCKERFILE = 'tool-host.Dockerfile';
/** The tool host's directory in the template: `tool-host.Dockerfile` copies `/workspace` to `/app`. */
export const APP_DIR = '/app';
/** What the Dockerfile's build stage copies into its context (`COPY` sources). */
export const CONTEXT_PATHS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'packages/contracts',
  'packages/platforms',
  'packages/sdk',
  'packages/cli',
  'packages/aw',
  'packages/tool-host',
];
/** The Dockerfile's build-stage `ENV`s, plus a non-interactive apt for the build VM (a provisioned system, not a layer). */
export const BUILD_ENV = ['PNPM_HOME', '/pnpm', 'CI', '1', 'DEBIAN_FRONTEND', 'noninteractive'];
/** The Dockerfile's final-stage `ENV`s. */
export const RUN_ENV = ['NODE_ENV', 'production', 'HOST', '0.0.0.0', 'PORT', '8788'];
const FILTER = '--filter @agent-workspace/tool-host...';
const BUILDS = [
  '@indx-workspace/contracts',
  '@indx-workspace/platforms',
  '@indx-workspace/sdk',
  '@indx-workspace/cli',
  '@indx-workspace/aw',
  '@agent-workspace/tool-host',
];
// Low concurrency keeps the install's peak memory down: it was OOM-killed in the E2B builder.
export const INSTALL_COMMAND = `pnpm install --frozen-lockfile --network-concurrency=4 --child-concurrency=1 ${FILTER}`;
export const BUILD_COMMANDS = BUILDS.map((name) => `pnpm --filter ${name} build`);
export const PRUNE_COMMAND = `find . -name node_modules -type d -prune -exec rm -rf {} + && pnpm install --frozen-lockfile --prod --offline ${FILTER}`;
/** The final stage's OS upgrade and removal of the package managers (ADR-0087); the store goes with them. */
export const STRIP_COMMAND =
  'apt-get update && apt-get -o Dpkg::Options::=--force-confold upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/* && rm -rf /usr/local/lib/node_modules /opt/yarn-v* /root/.npm /root/.cache /root/.local/share/pnpm && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg';

/**
 * The build context E2B uploads: the git-tracked files under `paths` as one deterministic `tar.gz`,
 * stored under the sha256 of the tar and its destination directory.
 *
 * @param {string} root @param {readonly string[]} paths @param {string} destination
 */
export function contextArchive(root, paths, destination) {
  const files = execFileSync('git', ['ls-files', '-z', '--', ...paths], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((file) => file !== '');
  const tar = execFileSync(
    'tar',
    [
      '--null',
      '-T',
      '-',
      '-cf',
      '-',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--mtime=@0',
      '--sort=name',
    ],
    { cwd: root, input: files.join('\0'), maxBuffer: 1 << 30 },
  );
  const hash = createHash('sha256').update(tar).update(destination).digest('hex');
  return { hash, archive: gzipSync(tar) };
}

/** @param {string} [root] */
export function toolHostBuild(root = REPOSITORY_ROOT) {
  const dockerfile = readFileSync(path.join(root, DOCKERFILE), 'utf8');
  const image = /^ARG NODE_IMAGE=(\S+)$/mu.exec(dockerfile)?.[1];
  const pnpm = /corepack prepare pnpm@(\S+) --activate/u.exec(dockerfile)?.[1];
  if (image === undefined || pnpm === undefined) {
    throw new Error(`${DOCKERFILE} names no base image or pnpm version`);
  }

  const upload = contextArchive(root, CONTEXT_PATHS, APP_DIR);

  return {
    image,
    steps: [
      { type: 'USER', args: ['root'] },
      { type: 'WORKDIR', args: ['/'] },
      // CI=1: `pnpm install --prod` prompts before purging node_modules and a build step has no TTY.
      { type: 'ENV', args: BUILD_ENV },
      { type: 'COPY', args: ['.', APP_DIR, '', ''], filesHash: upload.hash },
      { type: 'WORKDIR', args: [APP_DIR] },
      {
        type: 'RUN',
        args: [`corepack enable && corepack prepare pnpm@${pnpm} --activate`, 'root'],
      },
      { type: 'RUN', args: [`${INSTALL_COMMAND} && ${BUILD_COMMANDS.join(' && ')}`, 'root'] },
      { type: 'RUN', args: [PRUNE_COMMAND, 'root'] },
      { type: 'RUN', args: [STRIP_COMMAND, 'root'] },
      { type: 'ENV', args: RUN_ENV },
      // `USER 1000:1000` in the Dockerfile; that is the base image's `node` user.
      { type: 'USER', args: ['node'] },
    ],
    uploads: [upload],
  };
}
