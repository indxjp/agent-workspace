// The required, path-scoped jobs of ci.yml. ci-success counts a skipped job as a failure, so each
// filters paths in a step and never at job level, and must still really run its check.
import { CI_WORKFLOW, requireIncludes, withJob } from './ci-text.mjs';

// The two job-level gates of ci.yml's tiers (ci.yml, COST; ADR-0053, Amendment 2026-10-24): the
// heavy tier runs nightly, on a dispatch, on a `ci:full` pull request (never on its `edited` runs,
// which skip `build`) and as the release gate (`inputs.full`); `formal` and `image-scan` also run
// in the merge queue, path-scoped.
const HEAVY_TIER_CONDITION =
  "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || inputs.full || (github.event.action != 'edited' && contains(github.event.pull_request.labels.*.name, 'ci:full'))";
const QUEUE_TIER_CONDITION = `github.event_name == 'merge_group' || ${HEAVY_TIER_CONDITION}`;
/** @param {string} text */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const SCOPE_APPLIES = "if: steps.scope.outputs.applies == 'true'";

/**
 * The one job-level `if` allowed is a tier gate of ci.yml (COST): the heavy tier's, or for
 * `formal` the queue tier's. ci-success accepts the skip on a pull request, a push and in the
 * queue only.
 * @param {string[]} failures @param {string} job @param {string} jobId
 */
function checkNoJobLevelSkip(failures, job, jobId) {
  const tier = jobId === 'formal' ? QUEUE_TIER_CONDITION : HEAVY_TIER_CONDITION;
  const withoutQueueTier = job.replace(
    new RegExp(`^ {4}if: >-\\r?\\n {6}${escapeRegExp(tier)}\\r?\\n`, 'mu'),
    '',
  );
  if (/^ {4}(['"]?)if\1[ \t]*:/mu.test(withoutQueueTier)) {
    failures.push(
      `${CI_WORKFLOW}: ${jobId} must not be skipped at job level; filter paths in a step`,
    );
  }
  if (/^[ \t]*(?:-[ \t]+)?(['"]?)continue-on-error\1[ \t]*:/mu.test(job)) {
    failures.push(`${CI_WORKFLOW}: ${jobId} must not use continue-on-error`);
  }
}

/** @param {string} job @returns {string[][]} the job's steps, each as its lines */
function jobSteps(job) {
  /** @type {string[][]} */
  const steps = [];
  for (const line of job.split(/\r?\n/u)) {
    if (/^ {6}- /u.test(line)) steps.push([line]);
    else steps.at(-1)?.push(line);
  }
  return steps;
}

/** @param {string[]} failures @param {string[][]} steps @param {string} jobId */
function checkScopeStep(failures, steps, jobId) {
  const scope = steps.find((step) => step.some((line) => line.trim() === 'id: scope'));
  if (scope === undefined) {
    failures.push(`${CI_WORKFLOW}: ${jobId} must decide its path scope in a step with id: scope`);
    return;
  }
  const body = scope.join('\n');
  if (/\|[ \t]*grep\b[^\n]*[ \t]-[A-Za-z]*q/u.test(body)) {
    failures.push(
      `${CI_WORKFLOW}: ${jobId} scope step must not pipe into grep -q (fails open under pipefail); read the list first`,
    );
  }
  const answersTrueWithoutDiffBase =
    /if \[ -z "\$DIFF_BASE" \]; then\n {12}echo "applies=true" >> "\$GITHUB_OUTPUT"\n {12}exit 0\n/u;
  if (!answersTrueWithoutDiffBase.test(body)) {
    failures.push(
      `${CI_WORKFLOW}: ${jobId} scope step must answer applies=true for every event without a diff base`,
    );
  }
}

/**
 * @param {string[]} failures @param {string[][]} steps @param {string} jobId
 * @param {readonly (string | readonly [command: string, guard: string])[]} commands
 */
function checkGuardedCommands(failures, steps, jobId, commands) {
  for (const entry of commands) {
    const [command, guard] = typeof entry === 'string' ? [entry, SCOPE_APPLIES] : entry;
    const step = steps.find((candidate) => candidate.includes(`        run: ${command}`));
    const conditions = step?.filter((line) => /^ {8}(['"]?)if\1[ \t]*:/u.test(line)) ?? [];
    if (step === undefined || conditions.length !== 1 || conditions[0] !== `        ${guard}`) {
      failures.push(
        `${CI_WORKFLOW}: ${jobId} must include run: ${command} as a whole step guarded only by ${guard}`,
      );
    }
  }
}

/**
 * The policy every required, path-scoped job of ci.yml shares (`formal`, `generated-project-e2e`,
 * `app-kit-e2e`, `apps-e2e`, `journey-e2e`, `docs-claims`, `tool-sandbox-e2e`). ci-success counts a
 * skipped job as a failure, so such a job filters paths in a `scope` step and must still really run
 * its check when the diff reaches it. Text checks, like the rest of this file, but each one closes a
 * way to keep the job green while it runs nothing: a job-level `if` (however the key is quoted or
 * spaced), `continue-on-error`, a scope step that fails open (`git diff | grep -q` under pipefail
 * dies of SIGPIPE on a long diff and reads as "no match") or answers false for a push or a dispatch
 * (no DIFF_BASE), and a check whose `run:` line is commented out, suffixed (`|| true`) or guarded by
 * any condition other than the scope step's answer.
 * @param {string[]} failures
 * @param {string} job
 * @param {string} jobId
 * @param {readonly (string | readonly [command: string, guard: string])[]} commands each must be a
 *   step whose whole `run:` value is this command, guarded by the scope step's answer only, or by
 *   the given guard (a matrix leg's condition joined to that answer)
 */
function checkScopedRequiredJob(failures, job, jobId, commands) {
  checkNoJobLevelSkip(failures, job, jobId);
  const steps = jobSteps(job);
  checkScopeStep(failures, steps, jobId);
  checkGuardedCommands(failures, steps, jobId, commands);
}

/**
 * The required, path-scoped jobs, in check order. Each filters paths in a step and never at job
 * level, because ci-success counts a skipped job as a failure.
 * @type {readonly {
 *   jobId: string,
 *   commands: readonly (string | readonly [string, string])[],
 *   also?: (failures: string[], job: string) => void,
 * }[]}
 */
const SCOPED_REQUIRED_JOBS = [
  // The Lean specification job (docs/adr/0060): it must keep the checksum-verified elan install,
  // the soundness/generated-artefact check and the vector replay.
  {
    jobId: 'formal',
    commands: ['pnpm formal:build', 'pnpm formal:check'],
    also: (failures, job) =>
      requireIncludes(failures, job, 'formal', ['sha256sum -c', 'tests/formal']),
  },
  // The generated-project E2E (#398): a new user's whole flow against the change's own packages
  // and images.
  { jobId: 'generated-project-e2e', commands: ['node tests/generated-project/run.mjs'] },
  // The app-kit E2E (#1506): a generated app under `aw dev`, an agent writing as the person.
  { jobId: 'app-kit-e2e', commands: ['node tests/app-kit/run.mjs'] },
  // The apps lane (#1531): the example apps' installed benchmark cells.
  { jobId: 'apps-e2e', commands: ['node tests/apps/lane.mjs'] },
  // The developer-journey exit test (S1-19, #514). Two legs: the journey, and the first-hour
  // stopwatch beside it.
  {
    jobId: 'journey-e2e',
    commands: [
      [
        'node tests/journey/run.mjs',
        "if: matrix.part == 'journey' && steps.scope.outputs.applies == 'true'",
      ],
    ],
    also: (failures, job) => {
      if (!/^ {8}part: \[journey, first-hour\]$/mu.test(job)) {
        failures.push(
          `${CI_WORKFLOW}: journey-e2e must run the matrix part: [journey, first-hour]`,
        );
      }
    },
  },
  // The docs claims (#880).
  { jobId: 'docs-claims', commands: ['node tests/docs-claims/run.mjs'] },
  // The tool sandbox E2E (#847, ADR-0118).
  { jobId: 'tool-sandbox-e2e', commands: ['node tests/e2e/tool-sandbox.e2e.mjs'] },
];

/**
 * Every required, path-scoped job, in the gate's order.
 * @param {string[]} failures @param {string} ciSource
 */
export function validateScopedRequiredJobs(failures, ciSource) {
  for (const { jobId, commands, also } of SCOPED_REQUIRED_JOBS) {
    withJob(failures, ciSource, jobId, (job) => {
      checkScopedRequiredJob(failures, job, jobId, commands);
      also?.(failures, job);
    });
  }
}
