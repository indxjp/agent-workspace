// What `nx affected` selects for one kind of change (docs/adr/0053, Amendment 2026-11-19). The
// selection is the product of nx.json's named inputs (`production`, `code`) and target inputs, the
// test inputs of each project (tests/*/project.json, package.json `nx` blocks) and task-based
// affected (no `affected.legacy`): a docs-only change must reach no build, typecheck or lint, a
// test-only change nothing outside its own project (and the root typecheck and lint for tests/),
// and a source change everything downstream. Each case asks Nx itself (`nx affected --explain`,
// which runs nothing) so an input edit that silently widens or narrows CI shows up here,
// in fast-checks, before it costs or skips a run.
// Usage: node --test scripts/ci/nx-affected.test.mjs (needs the install, not the build).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGETS = ['build', 'typecheck', 'lint', 'test'];

/**
 * The task ids Nx selects for a change to `file`, sorted.
 * @param {string} file a repository-relative path that exists
 * @returns {{ affected: string[], total: number }}
 */
function affectedBy(file) {
  assert.ok(
    existsSync(join(ROOT, file)),
    `${file} no longer exists; pick another file of its kind`,
  );
  const stdout = execFileSync(
    'pnpm',
    ['exec', 'nx', 'affected', '-t', ...TARGETS, `--files=${file}`, '--explain=stdout'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NX_DAEMON: 'false' },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const explained =
    /** @type {{ affected: Record<string, unknown>, requested: { total: number } }} */ (
      JSON.parse(stdout)
    );
  return { affected: Object.keys(explained.affected).sort(), total: explained.requested.total };
}

// The tests/ tree is several Nx projects since ADR-0053 Amendment 2026-11-19f (tests/projects.mjs),
// each with the inputs its files read; the root project keeps only scripts/, its typecheck and its
// lint (which also cover tests/, package.json `nx` block).
test('a docs-only change runs only the tests that read that document', () => {
  assert.deepEqual(affectedBy('docs/40-operate/operations/runbook.md').affected, [
    'tests-docs:test',
  ]);
});

test('a docs-only change that no test reads runs nothing', () => {
  assert.deepEqual(
    affectedBy('docs/40-operate/operations/durable-execution-state.md').affected,
    [],
  );
});

test("a package's README reaches no build, typecheck or lint", () => {
  const { affected } = affectedBy('packages/sdk/README.md');
  assert.ok(affected.includes('@indx-workspace/sdk:test'));
  assert.deepEqual(
    affected.filter((task) => !task.endsWith(':test')),
    [],
  );
});

test("a package's test file re-runs that package's typecheck, lint and test, and no build", () => {
  const { affected } = affectedBy('packages/contracts/src/a2a.test.ts');
  for (const task of [
    '@indx-workspace/contracts:lint',
    '@indx-workspace/contracts:test',
    '@indx-workspace/contracts:typecheck',
  ]) {
    assert.ok(affected.includes(task), `${task} is missing from ${affected.join(', ')}`);
  }
  assert.deepEqual(
    affected.filter((task) => task.endsWith(':build') || task.startsWith('agent-workspace:')),
    [],
  );
});

test("a tests/ file re-runs its own project's tests and the root typecheck and lint", () => {
  assert.deepEqual(affectedBy('tests/tooling/adr-check.test.ts').affected, [
    'agent-workspace:lint',
    'agent-workspace:typecheck',
    'tests-tooling:test',
  ]);
});

test('Markdown the SDK ships in dist stays a build input, and reaches its dependents', () => {
  const { affected } = affectedBy('packages/sdk/src/project/templates/app/README.md');
  for (const task of [
    '@indx-workspace/sdk:build',
    '@indx-workspace/aw:test',
    '@indx-workspace/cli:test',
  ]) {
    assert.ok(affected.includes(task), `${task} is missing from ${affected.join(', ')}`);
  }
});

test('a source change reaches every target of the project and of its dependents', () => {
  const { affected } = affectedBy('packages/contracts/src/index.ts');
  for (const project of [
    '@indx-workspace/contracts',
    '@indx-workspace/sdk',
    '@agent-workspace/web',
  ]) {
    for (const target of TARGETS) {
      assert.ok(affected.includes(`${project}:${target}`), `${project}:${target} is not affected`);
    }
  }
  for (const task of ['agent-workspace:typecheck', 'agent-workspace:lint', 'tests:test']) {
    assert.ok(affected.includes(task), `${task} is not affected`);
  }
});

test('a change to nx.json selects every task', () => {
  const { affected, total } = affectedBy('nx.json');
  assert.equal(affected.length, total);
});
