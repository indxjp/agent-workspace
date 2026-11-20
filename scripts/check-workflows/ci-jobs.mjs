// The job-level policy of ci.yml, checked as text. Each function adds its failures to the shared
// list in the order validateCiWorkflow calls it, so the gate's output order never changes.
import { CI_WORKFLOW, WAVE_GATE_STEP, jobBlock, requireIncludes, withJob } from './ci-text.mjs';
import { validateScopedRequiredJobs } from './scoped-jobs.mjs';

/** @param {string[]} failures @param {string} fastChecks */
function checkFastChecks(failures, fastChecks) {
  if (/^ {4}services:/mu.test(fastChecks)) {
    failures.push(`${CI_WORKFLOW}: fast-checks must not provision service containers`);
  }
  requireIncludes(failures, fastChecks, 'fast-checks', [
    'Workflow policy and PR template gate',
    'node scripts/ci/check-nx-cache-config.mjs',
    'Changelog fragment gate',
    'No new type or lint suppressions in the diff',
    'Generated blocks are current',
    'pnpm dedupe --check',
    'node --test scripts/ci/nx-affected.test.mjs',
    'scripts/ci/ci-plan.test.mjs',
    'scripts/ci/ci-success.test.mjs',
    'pnpm format:check',
    'pnpm stories:check --base',
    'node scripts/check-licenses.mjs --dev',
    'Secret scan (gitleaks)',
    'Dependency vulnerability scan (osv-scanner)',
  ]);
  // docs:check runs in the background beside the other gates (ADR-0053, Amendment 2026-11-19d).
  // The job must start it, and a later step must wait for it and exit with its status: started
  // and never awaited, a red docs:check would end with the job still green.
  const docsStart = fastChecks.indexOf('pnpm docs:check > "$RUNNER_TEMP/docs-check.log"');
  const docsWait = fastChecks.indexOf('exit "$(cat "$RUNNER_TEMP/docs-check.status")"');
  if (docsStart === -1 || docsWait === -1 || docsWait < docsStart) {
    failures.push(
      `${CI_WORKFLOW}: fast-checks must start pnpm docs:check and later wait for it, exiting with its status`,
    );
  }
  if (fastChecks.includes('package-exports:check:artifacts')) {
    failures.push(`${CI_WORKFLOW}: built-artifact validation belongs in heavy-checks`);
  }
  // fast-checks is the job that fails a malformed pull request in seconds, so it waits for no
  // other job and runs no Nx task: anything that needs built packages belongs behind `build`.
  if (/^ {4}needs:/mu.test(fastChecks)) {
    failures.push(`${CI_WORKFLOW}: fast-checks must not wait for another job`);
  }
  if (/^\s+(?:run: )?scripts\/ci\/nx\.sh /mu.test(fastChecks)) {
    failures.push(`${CI_WORKFLOW}: fast-checks must not run Nx tasks; they belong behind build`);
  }
}

// The jobs that pack the published set need embedded's build too. They run after `build`
// and beside build-embedded, and .github/actions/workspace-build waits for its artifact (it
// reads the run's API, hence `actions: read`). A job that restored only `workspace-build`
// would pack without embedded and fail late.
// journey-e2e and docs-claims run on paid Blacksmith runners, so they need build-embedded
// outright rather than wait for its artifact on the clock.
const PACKING_JOBS = [
  'release-checks',
  'generated-project-e2e',
  'app-kit-e2e',
  'apps-e2e',
  'journey-e2e',
  'docs-claims',
];

/** @param {string[]} failures @param {string} ciSource */
function checkPackingJobsRestoreEmbedded(failures, ciSource) {
  for (const jobId of PACKING_JOBS) {
    const job = jobBlock(ciSource, jobId);
    const restoresEmbedded =
      job !== null &&
      /^ {4}needs: (build|\[build, build-embedded\])$/mu.test(job) &&
      /^ {6}actions: read$/mu.test(job) &&
      /uses: \.\/\.github\/actions\/workspace-build\n {8,10}with:\n {10,12}embedded: 'true'/u.test(
        job,
      );
    if (!restoresEmbedded) {
      failures.push(
        `${CI_WORKFLOW}: ${jobId} must need build, have actions: read and restore the workspace build with embedded: 'true'`,
      );
    }
  }
}

/**
 * The test shards come from the plan (scripts/ci/ci-plan.mjs TEST_SHARDS; its tests hold that every
 * test project lands in exactly one shard): the matrix is the plan's output, each leg tests exactly
 * the projects the plan gave it, and the no-skip gate runs on every leg.
 * @param {string[]} failures @param {string} heavyChecks
 */
function checkHeavyCheckShards(failures, heavyChecks) {
  if (!heavyChecks.includes('        include: ${{ fromJSON(needs.plan.outputs.test-shards) }}\n')) {
    failures.push(
      `${CI_WORKFLOW}: heavy-checks must take its matrix from the plan (include: fromJSON(needs.plan.outputs.test-shards))`,
    );
  }
  const noSkip = heavyChecks.match(
    /\n {6}- name: No test in the run was skipped\n((?: {8}.*\n)*)/u,
  )?.[1];
  if (noSkip === undefined || /^ {8}if:/mu.test(noSkip)) {
    failures.push(`${CI_WORKFLOW}: heavy-checks must run its no-skip gate on every leg, unguarded`);
  }
  // No shard restores embedded's build, so none waits for build-embedded.
  if (
    !/uses: \.\/\.github\/actions\/workspace-build\n {8}with:\n {10}embedded: 'false'\n/u.test(
      heavyChecks,
    )
  ) {
    failures.push(
      `${CI_WORKFLOW}: heavy-checks must restore the workspace build with embedded: 'false'`,
    );
  }
}

const FAST_ONLY_COMMANDS = [
  { label: 'pnpm typecheck', command: /^\s+run: pnpm typecheck$/mu },
  { label: 'pnpm lint', command: /^\s+run: pnpm lint$/mu },
  { label: 'pnpm architecture:check', command: /^\s+run: pnpm architecture:check$/mu },
  { label: 'pnpm deadcode:check', command: /^\s+run: pnpm deadcode:check$/mu },
  { label: 'pnpm duplication:check', command: /^\s+run: pnpm duplication:check$/mu },
];

/** @param {string[]} failures @param {string} heavyChecks */
function checkHeavyChecks(failures, heavyChecks) {
  // heavy-checks runs BESIDE fast-checks, not behind it: the two gate jobs no longer queue
  // on one another, and ci-success (below) is the single check that requires both. A
  // `needs: fast-checks` here would put the static gates back on the test job's critical
  // path.
  if (/^ {4}needs:.*fast-checks/mu.test(heavyChecks)) {
    failures.push(`${CI_WORKFLOW}: heavy-checks must run in parallel with fast-checks`);
  }
  if (!/^ {4}services:\s*$/mu.test(heavyChecks) || !heavyChecks.includes('postgres:18-alpine')) {
    failures.push(`${CI_WORKFLOW}: heavy-checks must provision the PostgreSQL 18 service`);
  }
  requireIncludes(failures, heavyChecks, 'heavy-checks', [
    'uses: ./.github/actions/workspace-build',
    'PostgreSQL service is a real PostgreSQL 18',
    'Start the S3 test server for the object-store contract suite',
    // The projects the plan gave this leg: the affected ones for a pull request or a queue group,
    // all of them in the heavy tier, never embedded (tested in build-embedded).
    'SHARD_PROJECTS: ${{ matrix.projects }}',
    'scripts/ci/nx.sh run-many -t test --projects="$SHARD_PROJECTS" ',
    'No test in the run was skipped',
    'run: node scripts/ci/vitest-no-skip.mjs',
    // The storage load test's scope is scripts/ci/load-scope.mjs (its backend SDK bumps included),
    // and its answer is used whole, so a failing script fails the step instead of answering false.
    '          answer="$(node scripts/ci/load-scope.mjs "$DIFF_BASE")"\n',
    "AW_LOAD_TESTS: '1'",
  ]);
  checkHeavyCheckShards(failures, heavyChecks);
  for (const { label, command } of FAST_ONLY_COMMANDS) {
    if (command.test(heavyChecks)) {
      failures.push(`${CI_WORKFLOW}: heavy-checks repeats fast check ${label}`);
    }
  }
  for (const misplacedCheck of [
    'No new type or lint suppressions in the diff',
    WAVE_GATE_STEP,
    'Generated blocks are current',
  ]) {
    if (heavyChecks.includes(misplacedCheck)) {
      failures.push(`${CI_WORKFLOW}: heavy-checks must not contain ${misplacedCheck}`);
    }
  }
}

// A red fast-checks cancels the run only where nothing else depends on the run finishing: a pull
// request and the merge queue. On a push to main, the nightly, a dispatch and the release gate the
// build writes the remote cache and the heavy tier runs, so a red fast-checks (most often an outside
// advisory) must leave them running; `CI success` still fails on it (ADR-0053, Amendment 2026-11-19).
const CANCEL_ON_FAST_FAILURE_IF =
  "    if: failure() && (github.event_name == 'pull_request' || github.event_name == 'merge_group')";

/** @param {string[]} failures @param {string} job */
function checkCancelOnFastFailure(failures, job) {
  if (
    !/^ {4}needs: fast-checks$/mu.test(job) ||
    !job.split('\n').includes(CANCEL_ON_FAST_FAILURE_IF)
  ) {
    failures.push(
      `${CI_WORKFLOW}: cancel-on-fast-failure must need fast-checks and run only on a failed pull_request or merge_group run, never cancelling the build of a push or the nightly`,
    );
  }
}

// THE FAST PATH (ADR-0053, Amendment 2026-11-19b): the jobs `plan` may skip. Each runs exactly when
// the plan's output of its own name is 'true' and needs the plan, and `CI success` accepts its skip
// only where that output is "false" (scripts/ci/ci-success.test.mjs runs the gate script itself).
const PLANNED_JOBS = ['build', 'build-embedded', 'typecheck-lint', 'heavy-checks'];
const PLANNED_SKIP_RULE =
  'elif (.key | IN("build", "build-embedded", "typecheck-lint", "heavy-checks")) then (($edited or $plan[.key] == "false") | not)';

/** @param {string[]} failures @param {string} ciSource */
function checkPlan(failures, ciSource) {
  const plan = jobBlock(ciSource, 'plan');
  if (plan === null) {
    failures.push(`${CI_WORKFLOW}: the plan job is missing`);
    return;
  }
  // Nothing may stand between a push and the plan, so the plan never waits for another job.
  if (/^ {4}needs:/mu.test(plan)) {
    failures.push(`${CI_WORKFLOW}: plan must not wait for another job`);
  }
  requireIncludes(failures, plan, 'plan', [
    "    if: >-\n      github.event.action != 'edited'\n",
    'id: plan',
    'run: node scripts/ci/ci-plan.mjs',
    ...[...PLANNED_JOBS, 'test-shards'].map(
      (key) => `      ${key}: \${{ steps.plan.outputs.${key} }}\n`,
    ),
  ]);
  for (const jobId of PLANNED_JOBS) {
    const job = jobBlock(ciSource, jobId);
    const ifLines = job?.match(/^ {4}(['"]?)if\1[ \t]*:.*$/gmu) ?? [];
    if (
      job === null ||
      !/^ {4}needs: (plan|\[plan, build\])$/mu.test(job) ||
      ifLines.length !== 1 ||
      ifLines[0] !== `    if: needs.plan.outputs.${jobId} == 'true'`
    ) {
      failures.push(
        `${CI_WORKFLOW}: ${jobId} must need plan and run only if: needs.plan.outputs.${jobId} == 'true'`,
      );
    }
  }
}

const CI_SUCCESS_NEEDS =
  'fast-checks, plan, build, build-embedded, typecheck-lint, heavy-checks, release-checks, release-images, formal, image-scan, generated-project-e2e, app-kit-e2e, apps-e2e, journey-e2e, docs-claims, tool-sandbox-e2e, coverage, browser';

/** @param {string[]} failures @param {string} ciSource */
function checkCiSuccess(failures, ciSource) {
  const ciSuccess = jobBlock(ciSource, 'ci-success');
  // The flow list, on one line or as Prettier wraps it once it passes the print width.
  const needs = ciSuccess
    ?.match(/^ {4}needs:\s*\[([^\]]*)\]$/mu)?.[1]
    ?.split(',')
    .map((need) => need.trim())
    .filter((need) => need !== '')
    .join(', ');
  if (
    ciSuccess === null ||
    !/^ {4}if: always\(\)$/mu.test(ciSuccess) ||
    needs !== CI_SUCCESS_NEEDS
  ) {
    failures.push(
      `${CI_WORKFLOW}: ci-success must run with if: always() and need fast-checks, plan, build, build-embedded, typecheck-lint, heavy-checks, release-checks, release-images, formal, image-scan, generated-project-e2e, app-kit-e2e, apps-e2e, journey-e2e, docs-claims, tool-sandbox-e2e, coverage and browser`,
    );
  }
  if (ciSuccess !== null && !ciSuccess.includes(PLANNED_SKIP_RULE)) {
    failures.push(
      `${CI_WORKFLOW}: ci-success must accept a skipped build, build-embedded, typecheck-lint or heavy-checks only where the plan said "false" for it`,
    );
  }
}

/**
 * Every job-level rule of ci.yml, in the gate's order.
 * @param {string[]} failures @param {string} ciSource
 */
export function validateCiWorkflow(failures, ciSource) {
  withJob(failures, ciSource, 'fast-checks', (job) => checkFastChecks(failures, job));
  // `build` builds every workspace but embedded once and hands the outputs to the other jobs;
  // `build-embedded` builds embedded beside it and runs embedded's tests, which read that build,
  // under the same no-skip gate as the test shards.
  withJob(failures, ciSource, 'build', (job) =>
    requireIncludes(failures, job, 'build', [
      'run: scripts/ci/nx.sh run-many -t build --exclude=@indx-workspace/embedded ',
      'name: workspace-build',
    ]),
  );
  withJob(failures, ciSource, 'build-embedded', (job) =>
    requireIncludes(failures, job, 'build-embedded', [
      'scripts/ci/nx.sh run @indx-workspace/embedded:build ',
      'name: embedded-build',
      'run: scripts/ci/nx.sh run @indx-workspace/embedded:test ',
      'run: node scripts/ci/vitest-no-skip.mjs',
    ]),
  );
  checkPackingJobsRestoreEmbedded(failures, ciSource);
  // Typecheck and lint, both targets in one job (ADR-0053, Amendment 2026-11-10: one setup
  // instead of two). Both spellings of each are required: the affected run is what a pull request
  // gets, the run-many is what `main` gets, and a workflow that dropped either would silently
  // narrow one of the two. All go through scripts/ci/nx.sh, so a remote-cache outage cannot fail
  // them (docs/adr/0110).
  withJob(failures, ciSource, 'typecheck-lint', (job) =>
    requireIncludes(failures, job, 'typecheck-lint', [
      'uses: ./.github/actions/workspace-build',
      'scripts/ci/nx.sh affected -t typecheck ',
      'scripts/ci/nx.sh run-many -t typecheck ',
      'scripts/ci/nx.sh affected -t lint ',
      'scripts/ci/nx.sh run-many -t lint ',
      'pnpm complexity:check',
      'pnpm clock:check',
      'pnpm durations:check',
      'pnpm architecture:check',
      'pnpm deadcode:check',
      'pnpm duplication:check',
    ]),
  );
  withJob(failures, ciSource, 'heavy-checks', (job) => checkHeavyChecks(failures, job));
  const fullE2e = jobBlock(ciSource, 'full-e2e');
  if (fullE2e === null || !/^ {4}needs: \[fast-checks, heavy-checks\]$/mu.test(fullE2e)) {
    failures.push(`${CI_WORKFLOW}: full-e2e must depend on fast-checks and heavy-checks`);
  }
  withJob(failures, ciSource, 'release-checks', (job) =>
    requireIncludes(failures, job, 'release-checks', [
      'uses: ./.github/actions/workspace-build',
      'run: pnpm package-exports:check:artifacts',
      'run: pnpm release:pack --smoke',
      'run: pnpm release:check',
    ]),
  );
  validateScopedRequiredJobs(failures, ciSource);
  checkPlan(failures, ciSource);
  withJob(failures, ciSource, 'cancel-on-fast-failure', (job) =>
    checkCancelOnFastFailure(failures, job),
  );
  checkCiSuccess(failures, ciSource);
}
