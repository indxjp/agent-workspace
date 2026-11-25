// The `plan` job's decisions (scripts/ci/ci-plan.mjs; docs/adr/0053, Amendment 2026-11-19b): which
// Nx jobs a run needs and how its test projects split over the heavy-checks shards. The pure cases
// pin the rules; the last cases ask Nx itself (`--explain`, which runs nothing) so an input change
// that would skip a job a change needs fails here, in fast-checks, before it skips one in CI.
// Usage: node --test scripts/ci/ci-plan.test.mjs (needs the install, not the build).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { test } from 'node:test';
import { URL } from 'node:url';

import {
  COVERAGE_SUITES,
  EMBEDDED_PROJECT,
  TEST_SHARDS,
  USE_CASES_PROJECT,
  affectedTasks,
  decidePlan,
  outputLines,
  shardLegs,
} from './ci-plan.mjs';
import { reachesFormal } from './formal-scope.mjs';
import { reachesStorageLoad } from './load-scope.mjs';
import { workflowJobs } from './workflow-jobs.mjs';

test('a full run needs every job and spreads every test project but embedded', () => {
  const plan = decidePlan({
    diffBase: 'origin/main',
    full: true,
    testProjects: ['tests', '@indx-workspace/aw', EMBEDDED_PROJECT, '@indx-workspace/x'],
  });
  assert.deepEqual(plan, {
    build: true,
    'build-embedded': true,
    'typecheck-lint': true,
    'heavy-checks': true,
    coverage: true,
    'test-shards': [
      { shard: 'tests', projects: 'tests' },
      { shard: 'aw-cli', projects: '@indx-workspace/aw' },
      { shard: 'rest', projects: '@indx-workspace/x' },
    ],
    'coverage-suites': [...COVERAGE_SUITES],
  });
});

test('a push to main (no diff base) builds both and runs nothing else', () => {
  assert.deepEqual(decidePlan({ diffBase: '', full: false }), {
    build: true,
    'build-embedded': true,
    'typecheck-lint': false,
    'heavy-checks': false,
    coverage: false,
    'test-shards': [],
    'coverage-suites': [],
  });
});

test('a diff that reaches no task needs no Nx job', () => {
  assert.deepEqual(decidePlan({ diffBase: 'origin/main', full: false, affectedTasks: [] }), {
    build: false,
    'build-embedded': false,
    'typecheck-lint': false,
    'heavy-checks': false,
    coverage: false,
    'test-shards': [],
    'coverage-suites': [],
  });
});

// ADR-0053 Amendment 2026-11-19c (owner decision D2, plan A): `formal` left the merge queue for the
// full tier, which always builds, so a pull request or a group builds only for its Nx tasks.
test('a diff that reaches no Nx task needs no Nx job, in the queue as on a pull request', () => {
  const plan = decidePlan({ diffBase: 'base', full: false, affectedTasks: [] });
  assert.deepEqual(plan, {
    build: false,
    'build-embedded': false,
    'typecheck-lint': false,
    'heavy-checks': false,
    coverage: false,
    'test-shards': [],
    'coverage-suites': [],
  });
});

test('only embedded tasks need build-embedded and not build', () => {
  const plan = decidePlan({
    diffBase: 'base',
    full: false,
    affectedTasks: [`${EMBEDDED_PROJECT}:build`, `${EMBEDDED_PROJECT}:test`],
  });
  assert.equal(plan.build, false);
  assert.equal(plan['build-embedded'], true);
  assert.equal(plan['heavy-checks'], false);
});

test('a test task alone needs build and its shard, not typecheck-lint', () => {
  const plan = decidePlan({
    diffBase: 'base',
    full: false,
    affectedTasks: ['tests:test'],
  });
  assert.equal(plan.build, true);
  assert.equal(plan['typecheck-lint'], false);
  assert.deepEqual(plan['test-shards'], [{ shard: 'tests', projects: 'tests' }]);
});

test('a lint task alone needs typecheck-lint', () => {
  const plan = decidePlan({
    diffBase: 'base',
    full: false,
    affectedTasks: ['agent-workspace:lint'],
  });
  assert.equal(plan['typecheck-lint'], true);
  assert.equal(plan['heavy-checks'], false);
});

test("embedded's own typecheck or lint alone plans build, which typecheck-lint needs", () => {
  for (const target of ['typecheck', 'lint']) {
    const plan = decidePlan({
      diffBase: 'base',
      full: false,
      affectedTasks: [`${EMBEDDED_PROJECT}:${target}`],
    });
    assert.equal(plan['typecheck-lint'], true, target);
    assert.equal(plan.build, true, target);
    assert.equal(plan['heavy-checks'], false, target);
  }
});

// ci.yml skips a job whose need was skipped, and ci-success fails a job the plan named that did not
// run. So every planned job's planned needs must be planned too, on every shape of plan.
test('every job the plan names has its ci.yml needs planned as well', () => {
  const source = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const planKeys = new Set(Object.keys(decidePlan({ diffBase: '', full: false })));
  /** @type {Map<string, string[]>} */
  const needs = new Map();
  for (const { id, lines } of workflowJobs(source)) {
    if (!planKeys.has(id)) continue;
    const line = lines.find(({ text }) => /^ {4}needs:/u.test(text))?.text ?? '';
    const listed = line
      .replace(/^ {4}needs:\s*/u, '')
      .replace(/[[\]]/gu, '')
      .split(',')
      .map((need) => need.trim())
      .filter((need) => planKeys.has(need));
    needs.set(id, listed);
  }
  assert.ok((needs.get('typecheck-lint') ?? []).includes('build'), 'ci.yml needs were not read');
  const taskSets = [
    [],
    [`${EMBEDDED_PROJECT}:typecheck`],
    [`${EMBEDDED_PROJECT}:lint`],
    [`${EMBEDDED_PROJECT}:test`],
    [`${EMBEDDED_PROJECT}:build`],
    ['tests:test'],
    ['agent-workspace:lint'],
    ['@agent-workspace/web:typecheck', `${EMBEDDED_PROJECT}:lint`],
    ['@agent-workspace/web:test', `${EMBEDDED_PROJECT}:test`],
    [`${USE_CASES_PROJECT}:test`],
    [`${USE_CASES_PROJECT}:lint`],
  ];
  const plans = [
    decidePlan({ diffBase: '', full: false }),
    decidePlan({ diffBase: 'base', full: true, testProjects: ['tests'] }),
    ...taskSets.map((tasks) => decidePlan({ diffBase: 'base', full: false, affectedTasks: tasks })),
  ];
  for (const plan of plans) {
    const planned = new Map(Object.entries(plan));
    for (const [job, jobNeeds] of needs) {
      if (planned.get(job) !== true) continue;
      for (const need of jobNeeds) {
        assert.equal(planned.get(need), true, `${job} is planned but its need ${need} is not`);
      }
    }
  }
});

test('every test project lands in exactly one shard', () => {
  const projects = [
    ...TEST_SHARDS.flatMap(({ projects: named }) => named ?? []),
    '@agent-workspace/runner',
    '@indx-workspace/contracts',
  ];
  const legs = shardLegs([...projects, ...projects]);
  const placed = legs.flatMap(({ projects: list }) => list.split(','));
  assert.deepEqual([...placed].sort(), [...new Set(projects)].sort());
  assert.equal(new Set(legs.map(({ shard }) => shard)).size, legs.length);
});

test('the output is one line per key, the shards as one JSON line', () => {
  const lines = outputLines(
    decidePlan({ diffBase: 'base', full: false, affectedTasks: ['@agent-workspace/web:test'] }),
  ).split('\n');
  assert.deepEqual(lines, [
    'build=true',
    'build-embedded=false',
    'typecheck-lint=false',
    'heavy-checks=true',
    'coverage=false',
    'test-shards=[{"shard":"web-core","projects":"@agent-workspace/web"}]',
    'coverage-suites=[]',
    '',
  ]);
});

test('the formal scope matches the model, its sources and what it cites, nothing else', () => {
  for (const file of [
    'formal/Spec.lean',
    'packages/contracts/src/index.ts',
    'packages/engine-pi/src/index.ts',
    'docs/adr/0053-x.md',
    'docs/sdk/site/index.md',
    '.github/workflows/ci.yml',
    'package.json',
  ]) {
    assert.ok(reachesFormal([file]), `${file} must reach formal`);
  }
  for (const file of [
    'docs/40-operate/operations/ci.md',
    'packages/contracts/README.md',
    'packages/web/package.json',
    'apps/web/app/page.tsx',
    '.github/workflows/quality.yml',
  ]) {
    assert.ok(!reachesFormal([file]), `${file} must not reach formal`);
  }
});

test('the storage load scope covers the storage code, its harness and its backend SDKs', () => {
  for (const file of [
    'packages/core/src/storage/s3.ts',
    'tests/load/object-store-round-trip.test.ts',
    'packages/core/package.json',
    'pnpm-lock.yaml',
  ]) {
    assert.ok(reachesStorageLoad([file]), `${file} must reach the storage load test`);
  }
  for (const file of [
    'packages/core/src/index.ts',
    'packages/web/package.json',
    'docs/40-operate/operations/ci.md',
    'apps/web/pnpm-lock.yaml',
  ]) {
    assert.ok(!reachesStorageLoad([file]), `${file} must not reach the storage load test`);
  }
});

// Every project a named shard lists must be a real test project: a renamed one would leave its
// tests to no shard at all (they would not fall back to `rest`, which skips every named project).
test('every project a shard names is a test project', () => {
  const projects = new Set(
    execFileSync(
      'pnpm',
      ['exec', 'nx', 'show', 'projects', '--json=false', '--with-target', 'test'],
      {
        encoding: 'utf8',
        env: { ...process.env, NX_DAEMON: 'false' },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
      .split('\n')
      .map((line) => line.trim()),
  );
  for (const project of [
    ...TEST_SHARDS.flatMap(({ projects: named }) => named ?? []),
    EMBEDDED_PROJECT,
  ]) {
    assert.ok(projects.has(project), `${project} has no test target`);
  }
});

test('a docs-only change skips build-embedded and typecheck-lint, and tests only its readers', () => {
  const plan = decidePlan({
    diffBase: 'base',
    full: false,
    affectedTasks: affectedTasks({ files: ['docs/40-operate/operations/runbook.md'] }),
  });
  assert.equal(plan['build-embedded'], false);
  assert.equal(plan['typecheck-lint'], false);
  assert.deepEqual(plan['test-shards'], [{ shard: 'tests', projects: 'tests-docs' }]);
});

test('a docs-only change no test reads needs no Nx job at all', () => {
  const plan = decidePlan({
    diffBase: 'base',
    full: false,
    affectedTasks: affectedTasks({
      files: ['docs/40-operate/operations/durable-execution-state.md'],
    }),
  });
  assert.deepEqual(plan, {
    build: false,
    'build-embedded': false,
    'typecheck-lint': false,
    'heavy-checks': false,
    coverage: false,
    'test-shards': [],
    'coverage-suites': [],
  });
});

test("a change to embedded's own source needs build-embedded and nothing in the shards", () => {
  const plan = decidePlan({
    diffBase: 'base',
    full: false,
    affectedTasks: affectedTasks({ files: ['packages/embedded/src/index.ts'] }),
  });
  assert.equal(plan['build-embedded'], true);
  assert.ok(plan['test-shards'].every(({ projects }) => !projects.includes(EMBEDDED_PROJECT)));
});

// The Agent Store 100-use-case plan, §7: the use cases' coverage suite runs on the pull request that
// reaches their tests; every other suite stays in the heavy tier.
test("a use case's test task plans the use cases' coverage suite, and only that one", () => {
  const plan = decidePlan({
    diffBase: 'base',
    full: false,
    affectedTasks: [`${USE_CASES_PROJECT}:test`, '@agent-workspace/web:test'],
  });
  assert.equal(plan.coverage, true);
  assert.deepEqual(
    plan['coverage-suites'].map(({ name }) => name),
    ['use-cases'],
  );
  assert.equal(plan.build, true);
  for (const tasks of [[`${USE_CASES_PROJECT}:lint`], ['@agent-workspace/web:test']]) {
    const other = decidePlan({ diffBase: 'base', full: false, affectedTasks: tasks });
    assert.equal(other.coverage, false, tasks.join());
    assert.deepEqual(other['coverage-suites'], [], tasks.join());
  }
});

test('every coverage suite is a package.json script over a config that exists', () => {
  const pkg = /** @type {{ scripts: Record<string, string> }} */ (
    JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  );
  assert.equal(new Set(COVERAGE_SUITES.map(({ name }) => name)).size, COVERAGE_SUITES.length);
  for (const suite of COVERAGE_SUITES) {
    const script = pkg.scripts[suite.script] ?? '';
    assert.match(script, new RegExp(`--config ${suite.config} --coverage`, 'u'), suite.name);
    const config = readFileSync(new URL(`../../${suite.config}`, import.meta.url), 'utf8');
    const directory = suite.summary.replace(/\/coverage-summary\.json$/u, '');
    assert.ok(config.includes(`'${directory}'`) || directory === 'coverage', suite.name);
  }
  assert.deepEqual(
    COVERAGE_SUITES.filter(({ scoreboard }) => scoreboard).map(({ name }) => name),
    ['use-cases'],
  );
});

test('a change touching only use-cases/<slug> runs only the scoped jobs', () => {
  const plan = decidePlan({
    diffBase: 'base',
    full: false,
    affectedTasks: affectedTasks({ files: ['use-cases/x/agents/x.ts'] }),
  });
  assert.deepEqual(
    { ...plan, 'coverage-suites': plan['coverage-suites'].map(({ name }) => name) },
    {
      build: true,
      'build-embedded': false,
      'typecheck-lint': true,
      'heavy-checks': true,
      coverage: true,
      // The use cases themselves, and the store's catalog test, which reads every use case folder.
      'test-shards': [
        { shard: 'tests', projects: 'tests-store' },
        { shard: 'rest', projects: USE_CASES_PROJECT },
      ],
      'coverage-suites': ['use-cases'],
    },
  );
});

test("a change to what the use cases' kit reads reaches the use cases' tests and coverage", () => {
  for (const file of [
    'examples/store/catalog/real-model-runs.json',
    'tests/apps/handwritten.ts',
    'tests/store/live-verify/source-hash.ts',
    // The packages the kit and the use cases import (use-cases/project.json implicitDependencies).
    'packages/sdk/src/index.ts',
    'packages/contracts/src/index.ts',
    // The real coverage config, which use-cases/kit/coverage.test.ts holds to the 100% rule.
    'vitest.use-cases.coverage.config.ts',
    'tests/gallery/contract-review/agents/contract-review.md',
    'examples/wiki/agents/assistant.ts',
  ]) {
    const plan = decidePlan({
      diffBase: 'base',
      full: false,
      affectedTasks: affectedTasks({ files: [file] }),
    });
    assert.equal(plan.coverage, true, file);
    assert.ok(
      plan['test-shards'].some(({ projects }) => projects.split(',').includes(USE_CASES_PROJECT)),
      file,
    );
  }
});
