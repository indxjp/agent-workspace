/* global fetch, AbortSignal, setTimeout, console */
import { record } from './lane-results.mjs';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildPinnedImages, checkoutRevision } from '../generated-project/images.mjs';
import { appSchema } from './lane-config.mjs';
import { attempt, tail } from './lane-commands.mjs';
import { withProductionApps } from './lane-deploy-plans.mjs';
export { laneRegistry } from './lane-registry.mjs';

export {
  withProductionApps,
  standInImage,
  composeAppsProblem,
  helmAppsProblem,
  renderedPlan,
  selfHostRender,
} from './lane-deploy-plans.mjs';

/** Whether a Docker daemon answers. */
export const dockerAnswers = () => attempt('docker', ['info'], { timeoutMs: 60_000 }).status === 0;

/**
 * Poll `url` until it answers 200 or `deadline` passes; the last status (0: never answered).
 *
 * @param {string} url @param {number} deadline
 */
async function healthOf(url, deadline) {
  let last = 0;
  while (Date.now() < deadline) {
    try {
      last = (await fetch(url, { signal: AbortSignal.timeout(5_000) })).status;
      if (last === 200) return last;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return last;
}

function preparePlatformBoot({ apps, copy, env, work, registry }) {
  const overrides = buildPinnedImages({
    registry: registry.host(),
    revision: checkoutRevision(),
    deadline: Date.now() + 30 * 60_000,
  });
  const home = path.join(work, 'deploy', 'boot');
  const project = path.join(home, 'project');
  rmSync(home, { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  const base = readFileSync(path.join(copy, 'agent-workspace.yaml'), 'utf8').replace(
    /^name: \S+$/mu,
    'name: apps-lane',
  );
  writeFileSync(
    path.join(project, 'agent-workspace.yaml'),
    withProductionApps(
      base,
      Object.fromEntries(apps.map(({ id, image }) => [id, image])),
      'single-vm',
    ),
  );
  const aw = path.join(copy, 'node_modules/@indx-workspace/aw/dist/index.js');
  const bootEnv = { ...env, ...overrides, HOME: home };
  const planned = attempt(process.execPath, [aw, 'deploy', 'production'], {
    cwd: project,
    env: bootEnv,
  });
  if (planned.status !== 0 && planned.status !== 3) {
    return { problem: `the boot plan exited ${String(planned.status)}:\n${tail(planned.output)}` };
  }
  const state = path.join(home, '.config/agent-workspace/deployments/apps-lane/production');
  const composeEnv = {
    ...bootEnv,
    COMPOSE_PROJECT_NAME: `apps-lane-${randomBytes(3).toString('hex')}`,
  };
  return { state, composeEnv };
}

async function appHealthProblem({ id, index, execution, platformUrl }) {
  const status = await healthOf(
    `http://127.0.0.1:${String(3100 + index)}/api/health`,
    Date.now() + 300_000,
  );
  const url = readDatabaseUrl(`app-${id}`, execution);
  if (status !== 200) return `GET /api/health answered ${String(status)}`;
  else if (url === '' || url === platformUrl || !url.startsWith(`postgres://${appSchema(id)}:`)) {
    return `app-${id} did not get a DATABASE_URL of its own role ${appSchema(id)}`;
  }
  return undefined;
}

/**
 * The self-host step's shared half: the platform's own images built into the lane's registry, one
 * `single-vm` plan with every app whose image built, `docker compose up` over its state, and each
 * app's `/api/health` and `DATABASE_URL`. A problem per app, empty when every one passed.
 *
 * @param {{ apps: { id: string, image: string }[], copy: string, env: NodeJS.ProcessEnv, work: string, registry: ReturnType<typeof laneRegistry> }} options
 * @returns {Promise<Map<string, string>>}
 */
async function bootPlatform({ apps, copy, env, work, registry }) {
  const problems = new Map();
  const everyApp = (/** @type {string} */ problem) => {
    for (const { id } of apps) problems.set(id, problem);
    return problems;
  };
  const prepared = preparePlatformBoot({ apps, copy, env, work, registry });
  if ('problem' in prepared) return everyApp(prepared.problem);
  const { state, composeEnv } = prepared;
  try {
    const up = attempt('docker', ['compose', 'up', '--detach'], {
      cwd: state,
      env: composeEnv,
      timeoutMs: 900_000,
    });
    if (up.status !== 0) return everyApp(`docker compose up failed:\n${tail(up.output)}`);
    const execution = { cwd: state, env: composeEnv };
    const platformUrl = readDatabaseUrl('web', execution);
    const sorted = [...apps].sort((left, right) => (left.id < right.id ? -1 : 1));
    for (const [index, { id }] of sorted.entries()) {
      const problem = await appHealthProblem({ id, index, execution, platformUrl });
      if (problem !== undefined) problems.set(id, problem);
    }
    return problems;
  } finally {
    attempt('docker', ['compose', 'down', '--volumes', '--remove-orphans'], {
      cwd: state,
      env: composeEnv,
    });
  }
}

export async function verifySelfHostedApps({ results, env, work, registry }) {
  const booted = results.filter((result) => result.image !== undefined);
  if (booted.length > 0) {
    console.log(
      `== booting the platform with ${booted.map((result) => result.benchmark.id).join(', ')}`,
    );
    /** @type {Map<string, string> | string} */
    let problems;
    try {
      problems = await bootPlatform({
        apps: booted.map((result) => ({ id: result.benchmark.id, image: result.image })),
        copy: booted[0].copy,
        env,
        work,
        registry,
      });
    } catch (error) {
      problems = `the boot threw: ${tail(String(error))}`;
    }
    for (const result of booted) {
      const problem = typeof problems === 'string' ? problems : problems.get(result.benchmark.id);
      record(
        result.benchmark.id,
        result.outcomes,
        'self-host',
        problem === undefined
          ? { status: 'ok', reason: 'rendered, booted and healthy on its own role' }
          : { status: 'failed', reason: problem },
      );
    }
  }
}

function readDatabaseUrl(service, execution) {
  return attempt(
    'docker',
    ['compose', 'exec', '-T', service, 'printenv', 'DATABASE_URL'],
    execution,
  ).stdout.trim();
}
