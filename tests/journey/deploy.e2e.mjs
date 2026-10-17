/* global process, console */
/**
 * The 80-14 demo's plan as a journey check (issue #621): a fresh project gets a `production`
 * environment, and `aw deploy production --plan` plans its single-VM Compose deployment from the
 * published release images, starting nothing.
 *
 * It runs only in the nightly `journey-live.yml`, never in PR CI: the plan needs Docker and the
 * release images the CLI pins, published and public (#370). It is standalone — `run.mjs` does not
 * start it — and drives the built `aw` of this checkout (`packages/aw/dist`), which loads
 * `@indx-workspace/cli` through the workspace link, as an install with the CLI beside it does.
 * `HOME` is a temporary directory, so the deployment's state never touches the runner's own.
 *
 * Named `.e2e.mjs`, not `.spec.mjs`, so the `tests` Vitest project never loads it.
 *
 *   node tests/journey/deploy.e2e.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const AW = fileURLToPath(new URL('../../packages/aw/dist/index.js', import.meta.url));
const PROJECT_NAME = 'journey-deploy';
const PRODUCTION = [
  '  production:',
  '    target: single-vm',
  '    url: https://agents.journey.example',
  '',
].join('\n');
/** The Compose services the single-vm recipe runs, each `create`d on a fresh VM. */
const SERVICES = ['postgres', 'seaweedfs', 'runner', 'web', 'gateway'];

/**
 * Run `aw <args>` in `cwd` with the temporary home; argument arrays only, never a shell.
 *
 * @param {string} cwd
 * @param {string} home
 * @param {readonly string[]} args
 */
function aw(cwd, home, args) {
  return spawnSync(process.execPath, [AW, ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    shell: false,
  });
}

const work = mkdtempSync(path.join(os.tmpdir(), 'journey-deploy-'));
const started = Date.now();
try {
  const home = path.join(work, 'home');
  const project = path.join(work, PROJECT_NAME);
  mkdirSync(home);
  mkdirSync(project);

  const init = aw(project, home, ['init', '--yes']);
  assert.equal(init.status, 0, `aw init --yes failed:\n${init.stderr}`);
  // `aw init` writes `environments:` last, with `local` beneath it.
  appendFileSync(path.join(project, 'agent-workspace.yaml'), PRODUCTION);

  const plan = aw(project, home, ['deploy', 'production', '--plan']);
  const output = `${plan.stdout}${plan.stderr}`;
  assert.equal(plan.status, 3, `aw deploy production --plan should exit 3:\n${output}`);
  assert.match(plan.stderr, /changes are pending; re-run with --yes/u);
  for (const service of SERVICES) {
    assert.match(plan.stdout, new RegExp(`^ {2}${service} +create$`, 'mu'), output);
  }

  const state = path.join(
    home,
    '.config',
    'agent-workspace',
    'deployments',
    PROJECT_NAME,
    'production',
  );
  const envFile = path.join(state, '.env');
  assert.equal(statSync(state).mode & 0o777, 0o700, 'the state directory is owner-only');
  assert.equal(statSync(envFile).mode & 0o777, 0o600, '.env is owner-only');
  const env = readFileSync(envFile, 'utf8');
  for (const key of ['BOOTSTRAP_ADMIN_PASSWORD', 'MASTER_ENCRYPTION_KEY', 'SESSION_SECRET']) {
    const secret = new RegExp(`^${key}=(.+)$`, 'mu').exec(env)?.[1];
    assert.ok(secret, `.env has no ${key}`);
    assert.ok(!output.includes(secret), `the plan printed ${key}`);
  }

  const containers = spawnSync(
    'docker',
    ['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${PROJECT_NAME}`],
    { encoding: 'utf8', shell: false },
  );
  assert.equal(containers.status, 0, containers.stderr);
  assert.equal(containers.stdout.trim(), '', 'a plan must start no container');

  console.log(
    `deploy journey: aw deploy production --plan passed in ${String((Date.now() - started) / 1000)}s`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
