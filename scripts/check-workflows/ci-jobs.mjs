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
    'pnpm format:check',
    'pnpm stories:check --base',
    'node scripts/check-licenses.mjs --dev',
    'Secret scan (gitleaks)',
    'Dependency vulnerability scan (osv-scanner)',
  ]);
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
 * The test shards: `rest` runs every project NAMED_PROJECTS does not list, so the list must be
 * exactly the projects the named shards run — a project in a shard but missing from the list would
 * run twice, one in the list but in no shard would never run.
 * @param {string[]} failures @param {string} heavyChecks
 */
function checkHeavyCheckShards(failures, heavyChecks) {
  const shardProjects = [...heavyChecks.matchAll(/^ {12}projects: '?([^'\n]*)'?$/gmu)]
    .flatMap((match) => (match[1] ?? '').split(/\s+/u))
    .filter((project) => project !== '')
    .sort();
  const namedProjects = (heavyChecks.match(/^ {10}NAMED_PROJECTS: '([^']*)'$/mu)?.[1] ?? '')
    .split(/\s+/u)
    .filter((project) => project !== '')
    .sort();
  if (
    !/^ {10}- shard: rest\n {12}projects: ''$/mu.test(heavyChecks) ||
    shardProjects.length === 0 ||
    shardProjects.join(' ') !== namedProjects.join(' ')
  ) {
    failures.push(
      `${CI_WORKFLOW}: heavy-checks NAMED_PROJECTS must list exactly the projects of its named shards, beside a \`rest\` shard with no projects`,
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
    // Same pair as typecheck-lint: the affected projects for pull requests, all for main.
    'nx show projects --json=false --with-target test --affected',
    'nx show projects --json=false --with-target test)',
    'scripts/ci/nx.sh run-many -t test',
    'No test in the run was skipped',
    'run: node scripts/ci/vitest-no-skip.mjs',
    // Tested in build-embedded, which is checked to run them.
    "ELSEWHERE_PROJECTS: '@indx-workspace/embedded'",
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

const CI_SUCCESS_NEEDS =
  'fast-checks, build, build-embedded, typecheck-lint, heavy-checks, release-checks, release-images, formal, image-scan, generated-project-e2e, app-kit-e2e, apps-e2e, journey-e2e, docs-claims, tool-sandbox-e2e, coverage, browser';

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
      `${CI_WORKFLOW}: ci-success must run with if: always() and need fast-checks, build, build-embedded, typecheck-lint, heavy-checks, release-checks, release-images, formal, image-scan, generated-project-e2e, app-kit-e2e, apps-e2e, journey-e2e, docs-claims, tool-sandbox-e2e, coverage and browser`,
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
  checkCiSuccess(failures, ciSource);
}
