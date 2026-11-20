// The `plan` job of ci.yml: which of the Nx jobs (`build`, `build-embedded`, `typecheck-lint`,
// `heavy-checks`) this run needs, and which test shards (docs/adr/0053, Amendment 2026-11-19b).
// A pull request and a merge-queue group ask Nx which tasks their diff reaches (`nx affected
// --explain`, task-based, which runs nothing); a job none of whose tasks is reached is skipped, and
// `CI success` accepts that skip only when this plan said `false` for it. A push to `main` builds (it
// writes the remote cache) and the nightly, a dispatch, a `ci:full` pull request and the release gate
// (`PLAN_FULL=true`) run everything, so neither ever asks Nx.
//
// Usage (ci.yml): DIFF_BASE=<base or empty> PLAN_FULL=<true|false> node scripts/ci/ci-plan.mjs
// It appends `build`, `build-embedded`, `typecheck-lint`, `heavy-checks` (each `true` or `false`)
// and `test-shards` (the heavy-checks matrix, JSON) to $GITHUB_OUTPUT, or prints them without it.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { testsProjects } from '../../tests/projects.mjs';

/** The project build-embedded builds and tests; no other job runs its tasks. */
export const EMBEDDED_PROJECT = '@indx-workspace/embedded';

/**
 * The heavy-checks shards, by measured time (main, 2026-10-15, seconds on a 16-vCPU runner): the
 * tests/ tree's projects (tests/projects.mjs, read from there so a project split out of `tests` is
 * never left to `rest`; the `tests` shard is the one that starts the Azure and GCS emulators and runs
 * the storage load step) get a runner to themselves; aw (178 s) with cli (82); web (132) with core
 * (128); every other project (each under 60 s) in `rest`, which is "every test project no other
 * shard names", so a new project is tested without editing this list. Embedded is tested in
 * build-embedded, beside its build.
 * @type {readonly { shard: string, projects: readonly string[] | null }[]}
 */
export const TEST_SHARDS = [
  { shard: 'tests', projects: testsProjects().map(({ name }) => name) },
  { shard: 'aw-cli', projects: ['@indx-workspace/aw', '@indx-workspace/cli'] },
  { shard: 'web-core', projects: ['@agent-workspace/web', '@agent-workspace/core'] },
  { shard: 'rest', projects: null },
];

/**
 * @typedef {{ shard: string, projects: string }} ShardLeg one heavy-checks matrix leg; `projects`
 *   is the comma-separated list `nx run-many --projects` takes
 * @typedef {{
 *   build: boolean,
 *   'build-embedded': boolean,
 *   'typecheck-lint': boolean,
 *   'heavy-checks': boolean,
 *   'test-shards': ShardLeg[],
 * }} Plan
 */

/**
 * Split test projects over the shards. Each project lands in exactly one leg; a shard with no
 * project in this run has no leg, and embedded never has one.
 * @param {readonly string[]} testProjects
 * @returns {ShardLeg[]}
 */
export function shardLegs(testProjects) {
  const named = new Set(TEST_SHARDS.flatMap(({ projects }) => projects ?? []));
  const wanted = [...new Set(testProjects)].filter((project) => project !== EMBEDDED_PROJECT);
  /** @type {ShardLeg[]} */
  const legs = [];
  for (const { shard, projects } of TEST_SHARDS) {
    const members = wanted
      .filter((project) => (projects === null ? !named.has(project) : projects.includes(project)))
      .sort();
    if (members.length > 0) legs.push({ shard, projects: members.join(',') });
  }
  return legs;
}

/**
 * The plan for one run.
 * @param {{
 *   diffBase: string,
 *   full: boolean,
 *   affectedTasks?: readonly string[],
 *   testProjects?: readonly string[],
 * }} input `affectedTasks` (`project:target` ids) is read only with a diff base; `testProjects`
 *   (every project with a `test` target) only for a full run.
 * @returns {Plan}
 */
export function decidePlan({ diffBase, full, affectedTasks = [], testProjects = [] }) {
  if (full) {
    const legs = shardLegs(testProjects);
    return {
      build: true,
      'build-embedded': true,
      'typecheck-lint': true,
      'heavy-checks': legs.length > 0,
      'test-shards': legs,
    };
  }
  if (diffBase === '') {
    // A push to main: build both (the builds write the remote cache), nothing else (ci.yml, COST).
    return {
      build: true,
      'build-embedded': true,
      'typecheck-lint': false,
      'heavy-checks': false,
      'test-shards': [],
    };
  }
  const tasks = affectedTasks.map((id) => {
    const colon = id.lastIndexOf(':');
    return { project: id.slice(0, colon), target: id.slice(colon + 1) };
  });
  const legs = shardLegs(
    tasks.filter(({ target }) => target === 'test').map(({ project }) => project),
  );
  const typecheckLint = tasks.some(({ target }) => target === 'typecheck' || target === 'lint');
  return {
    // `build` hands every other job its packages. `formal`, which also needs them, runs only in the
    // full tier since ADR-0053 Amendment 2026-11-19c (plan A), and a full run always builds.
    // typecheck-lint and heavy-checks have `needs: [plan, build]` in ci.yml, so either one planned
    // plans build too: embedded's own typecheck or lint alone would otherwise skip typecheck-lint
    // (its need skipped) and fail ci-success, which expects the job the plan named.
    build:
      typecheckLint || legs.length > 0 || tasks.some(({ project }) => project !== EMBEDDED_PROJECT),
    'build-embedded': tasks.some(({ project }) => project === EMBEDDED_PROJECT),
    'typecheck-lint': typecheckLint,
    'heavy-checks': legs.length > 0,
    'test-shards': legs,
  };
}

/** @param {string[]} args @returns {string} */
function nx(args) {
  return execFileSync('pnpm', ['exec', 'nx', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NX_DAEMON: 'false' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/**
 * The `project:target` ids of build, typecheck, lint and test that a diff reaches.
 * @param {{ base: string } | { files: readonly string[] }} change a diff base (against HEAD), or
 *   an explicit file list (the tests)
 * @returns {string[]}
 */
export function affectedTasks(change) {
  const scope =
    'base' in change
      ? [`--base=${change.base}`, '--head=HEAD']
      : [`--files=${change.files.join(',')}`];
  const explained = /** @type {{ affected: Record<string, unknown> }} */ (
    JSON.parse(
      nx(['affected', '-t', 'build', 'typecheck', 'lint', 'test', ...scope, '--explain=stdout']),
    )
  );
  return Object.keys(explained.affected).sort();
}

/** @returns {string[]} every project with a `test` target */
function allTestProjects() {
  // --json=false: Nx 24 prints JSON when it detects an AI agent; one name per line otherwise.
  return nx(['show', 'projects', '--json=false', '--with-target', 'test'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** @param {Plan} plan @returns {string} the $GITHUB_OUTPUT lines */
export function outputLines(plan) {
  return [
    `build=${String(plan.build)}`,
    `build-embedded=${String(plan['build-embedded'])}`,
    `typecheck-lint=${String(plan['typecheck-lint'])}`,
    `heavy-checks=${String(plan['heavy-checks'])}`,
    `test-shards=${JSON.stringify(plan['test-shards'])}`,
    '',
  ].join('\n');
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  const diffBase = process.env['DIFF_BASE'] ?? '';
  const full = process.env['PLAN_FULL'] === 'true';
  const plan = decidePlan({
    diffBase,
    full,
    ...(full ? { testProjects: allTestProjects() } : {}),
    ...(!full && diffBase !== '' ? { affectedTasks: affectedTasks({ base: diffBase }) } : {}),
  });
  const lines = outputLines(plan);
  process.stdout.write(lines);
  const output = process.env['GITHUB_OUTPUT'];
  if (output !== undefined && output !== '') appendFileSync(output, lines);
}
