/**
 * The images tests/e2e/tool-sandbox.e2e.mjs builds before `docker compose up --build`, and a
 * `--warm` mode that builds those and every build target compose.yaml declares into the Docker
 * host's build cache. CI runs `node tests/e2e/tool-sandbox-images.mjs --warm` before the workspace
 * build is restored (this module imports no built package), so the E2E's own builds are cache hits.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** The images `compose.yaml` expects on the daemon, built outside compose. */
/** @type {ReadonlyArray<readonly [dockerfile: string, target: string, tag: string, args: readonly string[]]>} */
export const IMAGES = [
  [
    'runtime.Dockerfile',
    'runtime',
    'agent-workspace/runtime:dev',
    ['--build-arg', 'ENGINE=claude-agent-sdk'],
  ],
  ['egress-proxy.Dockerfile', 'egress-proxy', 'agent-workspace/egress-proxy:dev', []],
  ['tool-host.Dockerfile', 'tool-host', 'agent-workspace/tool-host:dev', []],
];

/** Each distinct `dockerfile` + `target` pair of a service's `build:` in compose.yaml. */
export function composeBuildTargets(root = ROOT) {
  const text = readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  const pairs = [...text.matchAll(/^ +dockerfile: (\S+)\n +target: (\S+)$/gmu)].map(
    (match) => `${String(match[1])} ${String(match[2])}`,
  );
  return [...new Set(pairs)].map((pair) => /** @type {[string, string]} */ (pair.split(' ')));
}

/**
 * Each service of compose.yaml with a `build:`, except `migrate`. It shares `web`'s build and tag,
 * and on the containerd image store one `up --build` exporting that tag twice fails ("image ...
 * already exists"), so the E2E builds these and starts the stack without `--build`.
 */
export function composeBuildServices(root = ROOT) {
  const text = readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  return [...text.matchAll(/^ {2}([a-z][a-z-]*):\n {4}build:$/gmu)]
    .map((match) => String(match[1]))
    .filter((name) => name !== 'migrate');
}

/** @param {readonly string[]} args */
export function docker(args) {
  const result = spawnSync('docker', args, { cwd: ROOT, stdio: 'inherit', timeout: 1_800_000 });
  if (result.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} failed`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  if (process.argv.slice(2).join(' ') !== '--warm') {
    process.stderr.write('usage: node tests/e2e/tool-sandbox-images.mjs --warm\n');
    process.exit(2);
  }
  for (const [dockerfile, target, tag, args] of IMAGES) {
    docker(['build', '--file', dockerfile, '--target', target, ...args, '--tag', tag, '.']);
  }
  for (const [dockerfile, target] of composeBuildTargets()) {
    docker(['build', '--file', dockerfile, '--target', target, '.']);
  }
}
