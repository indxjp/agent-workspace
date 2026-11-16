/* global console */
import { spawnSync } from 'node:child_process';
import { toolSandboxRunToken } from '@agent-workspace/gateway/tokens';
import { IMAGES } from './tool-sandbox-images.mjs';
import { ROOT, PROJECT, ALLOWED_HOST } from './tool-sandbox-project.mjs';

/** @param {string} message @param {boolean} ok */
export function check(ok, message) {
  if (!ok) throw new Error(`E2E assertion failed: ${message}`);
  console.log(`ok: ${message}`);
}

/** @param {readonly string[]} args */
/** @param {readonly string[]} args @returns {string} what the command printed */
function dockerOutput(args) {
  const result = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')} failed`);
  return result.stdout;
}

export async function assertSandboxIsolation(reply, declaredValue, gatewaySecret, runId) {
  // What the tool saw inside its sandbox (TS4, TS5).
  check(
    reply.includes(`declared=${declaredValue}`),
    'the tool read the secret it declared, set through the API',
  );
  check(
    reply.includes('database_url=absent'),
    'the tool does not see DATABASE_URL, which it never declared',
  );
  check(
    /allowed=reached:\d+/u.test(reply),
    `the proxy let the declared host ${ALLOWED_HOST} through (${reply})`,
  );
  check(
    reply.includes('refused=denied:host_not_allowed'),
    `the proxy refused example.com, which the tool never declared (${reply})`,
  );
  // TS3: the tool sandbox's bearer never reaches the agent's runtime container.
  const bearer = await toolSandboxRunToken(gatewaySecret, runId);
  const agentContainers = dockerOutput([
    'ps',
    '--quiet',
    '--filter',
    'label=agent-workspace.runtime',
    '--filter',
    `ancestor=${IMAGES[0][2]}`,
  ])
    .split('\n')
    .filter(Boolean);
  check(agentContainers.length > 0, 'the agent runtime container is still running');
  for (const id of agentContainers) {
    check(
      !dockerOutput(['inspect', id]).includes(bearer),
      `the tool sandbox bearer is not in docker inspect of the agent runtime ${id}`,
    );
    // grep exits 1 when nothing matches, 0 when a file holds the bearer, 2 on an error.
    const grep = spawnSync(
      'docker',
      ['exec', id, 'grep', '-rlsF', '--', bearer, '/workspace', '/tmp'],
      { encoding: 'utf8' },
    );
    check(
      grep.status === 1,
      `the tool sandbox bearer is in no file of the agent runtime ${id} (grep ${String(grep.status)}: ${grep.stdout.trim()})`,
    );
  }
}

export async function assertPromotion(aw) {
  // Acceptance 2: promote succeeds with no hand-seeded connector.
  aw(['promote', 'assistant', '1', '--yes']);
  const promoted = JSON.parse(aw(['versions', '--json']));
  check(
    promoted.pointers.some(
      (/** @type {{ environment: string, number: number }} */ p) =>
        p.environment === 'production' && p.number === 1,
    ),
    'aw promote moved production to the code-tool version',
  );
}

export function cleanSandboxStack(failed) {
  if (failed) {
    spawnSync(
      'docker',
      ['compose', '--project-name', PROJECT, 'logs', '--no-color', '--tail', '200'],
      { cwd: ROOT, stdio: 'inherit' },
    );
    // The egress proxies run outside compose; their denial lines show whether a probe reached one.
    const proxies = spawnSync(
      'docker',
      ['ps', '--all', '--quiet', '--filter', `ancestor=${IMAGES[1][2]}`],
      { encoding: 'utf8' },
    )
      .stdout.split('\n')
      .filter(Boolean);
    for (const id of proxies) {
      console.error(`--- egress proxy ${id} ---`);
      spawnSync('docker', ['logs', '--tail', '200', id], { stdio: 'inherit' });
    }
  }
  spawnSync(
    'docker',
    [
      'compose',
      '--project-name',
      PROJECT,
      'down',
      '--volumes',
      '--remove-orphans',
      '--timeout',
      '5',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  // ponytail: removes every runtime and tool-host container on the daemon, not only this
  // project's; the E2E is documented to need a disposable daemon.
  const leftovers = spawnSync(
    'docker',
    ['ps', '--all', '--quiet', '--filter', 'label=agent-workspace.runtime'],
    { encoding: 'utf8' },
  )
    .stdout.split('\n')
    .filter(Boolean);
  if (leftovers.length > 0)
    spawnSync('docker', ['rm', '--force', '--volumes', ...leftovers], { stdio: 'inherit' });
}
