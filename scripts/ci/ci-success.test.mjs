// `CI success`'s gate script, run as written in ci.yml against fixed `needs` contexts: which skips
// it accepts (docs/adr/0053, Amendment 2026-11-19b). The jobs the `plan` job decides on (build,
// build-embedded, typecheck-lint, heavy-checks and coverage) pass skipped only where the plan answered
// "false" for them, or on a body/title edit; every other job keeps the tier rule (a skip passes on a
// pull request, a push and in the queue, never on the nightly, a dispatch or the release gate).
// Usage: node --test scripts/ci/ci-success.test.mjs (needs bash and jq, as the job does).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { workflowJobs } from './workflow-jobs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');

/** The `run: |` body of ci-success's one step, dedented. */
function gateScript() {
  const job = workflowJobs(ci).find(({ id }) => id === 'ci-success');
  if (job === undefined) throw new Error('ci.yml has no ci-success job');
  const lines = job.lines.map(({ text }) => text);
  const start = lines.findIndex((line) => line === '        run: |');
  if (start < 0) throw new Error('ci-success has no `run: |` step');
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

const SCRIPT = gateScript();

/**
 * Run the gate as GitHub would after substituting its expressions.
 * @param {{ event: string, full?: boolean, edited?: boolean, needs: Record<string, unknown> }} run
 * @returns {{ ok: boolean, output: string }}
 */
function gate({ event, full = false, edited = false, needs }) {
  const script = SCRIPT.replaceAll('${{ github.event_name }}', event).replaceAll(
    '${{ inputs.full }}',
    full ? 'true' : '',
  );
  assert.ok(!script.includes('${{'), `an expression is left unsubstituted:\n${script}`);
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'], NEEDS_JSON: JSON.stringify(needs), EDITED: String(edited) },
  });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

const JOBS = [
  'fast-checks',
  'build',
  'build-embedded',
  'typecheck-lint',
  'heavy-checks',
  'release-checks',
  'release-images',
  'formal',
  'image-scan',
  'generated-project-e2e',
  'app-kit-e2e',
  'apps-e2e',
  'journey-e2e',
  'docs-claims',
  'tool-sandbox-e2e',
  'coverage',
  'browser',
];

/**
 * A needs context: every job skipped but those given, `plan` with the given outputs.
 * @param {Record<string, string>} results job -> result
 * @param {Record<string, string> | null} plan the plan's outputs, or null for a skipped plan
 */
function needs(results, plan) {
  /** @type {Record<string, unknown>} */
  const context = {
    plan: plan === null ? { result: 'skipped', outputs: {} } : { result: 'success', outputs: plan },
  };
  for (const job of JOBS) context[job] = { result: results[job] ?? 'skipped', outputs: {} };
  return context;
}

const DOCS_ONLY_PLAN = {
  build: 'true',
  'build-embedded': 'false',
  'typecheck-lint': 'false',
  'heavy-checks': 'true',
  coverage: 'false',
  'test-shards': '[{"shard":"tests","projects":"agent-workspace"}]',
  'coverage-suites': '[]',
};

test('a docs-only pull request passes with the jobs its plan skipped', () => {
  const { ok, output } = gate({
    event: 'pull_request',
    needs: needs(
      { 'fast-checks': 'success', build: 'success', 'heavy-checks': 'success' },
      DOCS_ONLY_PLAN,
    ),
  });
  assert.ok(ok, output);
});

test('a planned job that did not run fails, whatever the event allows', () => {
  for (const event of ['pull_request', 'push', 'merge_group']) {
    const { ok, output } = gate({
      event,
      needs: needs(
        { 'fast-checks': 'success', build: 'success' },
        { ...DOCS_ONLY_PLAN, 'typecheck-lint': 'true', 'heavy-checks': 'false' },
      ),
    });
    assert.ok(!ok, `${event} passed`);
    assert.match(output, /typecheck-lint: skipped/u);
  }
});

test('a plan that did not succeed fails the run', () => {
  for (const result of ['failure', 'cancelled', 'skipped']) {
    const context = needs({ 'fast-checks': 'success' }, DOCS_ONLY_PLAN);
    context['plan'] = { result, outputs: {} };
    const { ok, output } = gate({ event: 'pull_request', needs: context });
    assert.ok(!ok, `plan ${result} passed`);
    assert.match(output, new RegExp(`plan: ${result}`, 'u'));
  }
});

test('a skipped planned job with no plan output fails', () => {
  const { ok } = gate({
    event: 'pull_request',
    needs: needs({ 'fast-checks': 'success' }, {}),
  });
  assert.ok(!ok);
});

test('a body or title edit passes with only the fast checks', () => {
  const { ok, output } = gate({
    event: 'pull_request',
    edited: true,
    needs: needs({ 'fast-checks': 'success' }, null),
  });
  assert.ok(ok, output);
});

test('a planned job that failed fails even where the plan skipped it', () => {
  const { ok } = gate({
    event: 'pull_request',
    needs: needs(
      {
        'fast-checks': 'success',
        build: 'success',
        'heavy-checks': 'success',
        'build-embedded': 'failure',
      },
      DOCS_ONLY_PLAN,
    ),
  });
  assert.ok(!ok);
});

test('the nightly fails on a skipped heavy-tier job, as before', () => {
  const allTrue = {
    build: 'true',
    'build-embedded': 'true',
    'typecheck-lint': 'true',
    'heavy-checks': 'true',
    coverage: 'true',
  };
  const results = Object.fromEntries(JOBS.map((job) => [job, 'success']));
  assert.ok(gate({ event: 'schedule', needs: needs(results, allTrue) }).ok);
  const { ok, output } = gate({
    event: 'schedule',
    needs: needs({ ...results, coverage: 'skipped' }, allTrue),
  });
  assert.ok(!ok);
  assert.match(output, /coverage: skipped/u);
});

test('a push to main passes with the build only, as its plan says', () => {
  const { ok, output } = gate({
    event: 'push',
    needs: needs(
      { 'fast-checks': 'success', build: 'success', 'build-embedded': 'success' },
      {
        build: 'true',
        'build-embedded': 'true',
        'typecheck-lint': 'false',
        'heavy-checks': 'false',
        coverage: 'false',
      },
    ),
  });
  assert.ok(ok, output);
});

// The use cases' coverage suite runs on the pull request that reaches their tests (the Agent Store
// 100-use-case plan, §7), so there a skipped coverage job fails like any other planned job.
test('coverage is required on a pull request whose plan names it, and only there', () => {
  const useCasesPlan = { ...DOCS_ONLY_PLAN, coverage: 'true' };
  const ran = { 'fast-checks': 'success', build: 'success', 'heavy-checks': 'success' };
  for (const event of ['pull_request', 'merge_group']) {
    const skipped = gate({ event, needs: needs(ran, useCasesPlan) });
    assert.ok(!skipped.ok, `${event} passed without the planned coverage`);
    assert.match(skipped.output, /coverage: skipped/u);
    const failed = gate({ event, needs: needs({ ...ran, coverage: 'failure' }, useCasesPlan) });
    assert.ok(!failed.ok, `${event} passed with a failed coverage`);
    assert.ok(gate({ event, needs: needs({ ...ran, coverage: 'success' }, useCasesPlan) }).ok);
    assert.ok(gate({ event, needs: needs(ran, DOCS_ONLY_PLAN) }).ok);
  }
});
