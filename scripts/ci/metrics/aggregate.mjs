// Pure aggregation for the CI metrics report: runner classes, the price table, and the tables the
// report prints. Nothing here reads the network or the clock; `report.mjs` passes everything in,
// which is what lets the recorded fixtures in `tests/ci-metrics/` pin every number.

/** @typedef {import('./github.mjs').WorkflowRun} WorkflowRun */
/** @typedef {import('./github.mjs').WorkflowJob} WorkflowJob */
/** @typedef {import('./github.mjs').PullRequest} PullRequest */

/**
 * Estimated USD per billed minute. The one place prices live; every figure in the report is
 * `billed minutes × rate`, so changing a rate here changes every estimate consistently.
 *
 * - Blacksmith x64: $0.004/min at 2 vCPU, doubling with each size (4 → 0.008, 8 → 0.016, …).
 * - Blacksmith ARM: about 37 % cheaper than x64 of the same size.
 * - Blacksmith Windows: assumed at twice the Linux x64 rate of the same size (no list price
 *   checked); the report says "estimated" for that reason.
 * - GitHub-hosted: the standard runner list prices from 2026-01-01 (Linux 2-core x64 $0.006/min).
 *   The minutes an internal repository's plan includes are not subtracted: this is list price.
 * - Self-hosted: $0 — the machine is paid for elsewhere, so only its minutes are reported.
 * - Blacksmith macOS (`blacksmith-<n>vcpu-macos`): no rate here, so $0 — its minutes are
 *   reported, its cost is not estimated.
 */
export const PRICE_TABLE = Object.freeze({
  blacksmithX64Per2Vcpu: 0.004,
  blacksmithArmFactor: 0.63,
  blacksmithWindowsFactor: 2,
  githubHosted: Object.freeze({
    'github-hosted': 0.006,
    'github-hosted-arm': 0.005,
    'github-hosted-windows': 0.01,
    'github-hosted-macos': 0.062,
  }),
  selfHosted: 0,
});

/** Runner groups the budget may name instead of an individual class. */
export const RUNNER_GROUPS = Object.freeze(['blacksmith', 'github-hosted', 'self-hosted', 'other']);

/**
 * The runner class of a job from its `runs-on` labels.
 * @param {readonly string[] | null | undefined} labels
 * @returns {string}
 */
export function runnerClass(labels) {
  const lower = (labels ?? []).map((label) => label.toLowerCase());
  if (lower.length === 0) return 'unassigned';
  if (lower.includes('self-hosted')) return 'self-hosted';
  for (const label of lower) {
    const blacksmith = /^blacksmith-(\d+)vcpu-(ubuntu|windows|macos)-[\w.]+?(-arm)?$/u.exec(label);
    if (blacksmith) {
      const os = blacksmith[2] === 'ubuntu' ? '' : `-${blacksmith[2]}`;
      const arm = blacksmith[3] ? '-arm' : '';
      return `blacksmith-${blacksmith[1]}vcpu${os}${arm}`;
    }
  }
  for (const label of lower) {
    if (/^ubuntu-(latest|[\d.]+)-arm$/u.test(label)) return 'github-hosted-arm';
    if (/^ubuntu-(latest|[\d.]+)$/u.test(label)) return 'github-hosted';
    if (/^windows-(latest|[\d.]+)$/u.test(label)) return 'github-hosted-windows';
    if (/^macos-(latest|[\d.]+)/u.test(label)) return 'github-hosted-macos';
  }
  return 'other';
}

/**
 * @param {string} cls a runner class from {@link runnerClass}
 * @returns {string} one of {@link RUNNER_GROUPS}
 */
export function runnerGroup(cls) {
  if (cls.startsWith('blacksmith-')) return 'blacksmith';
  if (cls.startsWith('github-hosted')) return 'github-hosted';
  if (cls === 'self-hosted') return 'self-hosted';
  return 'other';
}

/**
 * Estimated USD per minute for a runner class (0 when unknown, so an unknown class is visible as
 * minutes without an invented price).
 * @param {string} cls
 * @returns {number}
 */
export function pricePerMinute(cls) {
  const blacksmith = /^blacksmith-(\d+)vcpu(-windows)?(-arm)?$/u.exec(cls);
  if (blacksmith) {
    const base = PRICE_TABLE.blacksmithX64Per2Vcpu * (Number(blacksmith[1]) / 2);
    const windows = blacksmith[2] ? PRICE_TABLE.blacksmithWindowsFactor : 1;
    const arm = blacksmith[3] ? PRICE_TABLE.blacksmithArmFactor : 1;
    return base * windows * arm;
  }
  if (cls === 'self-hosted') return PRICE_TABLE.selfHosted;
  return /** @type {Record<string, number>} */ (PRICE_TABLE.githubHosted)[cls] ?? 0;
}

/**
 * Nearest-rank percentile; null for no samples.
 * @param {readonly number[]} values
 * @param {number} p 0–100
 * @returns {number | null}
 */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return /** @type {number} */ (sorted[rank - 1]);
}

/**
 * Seconds between two ISO timestamps, or null when either is missing or the span is negative.
 * @param {string | null | undefined} start
 * @param {string | null | undefined} end
 * @returns {number | null}
 */
export function spanSeconds(start, end) {
  if (!start || !end) return null;
  const seconds = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** Paths whose change alone makes a pull request docs-only. */
const DOCS_ONLY = [/^docs\//u, /\.md$/u, /^changes\//u, /^llms\.txt$/u];

/**
 * @param {readonly string[]} files
 * @returns {boolean}
 */
export function isDocsOnly(files) {
  return files.length > 0 && files.every((file) => DOCS_ONLY.some((pattern) => pattern.test(file)));
}

const PR_EVENTS = new Set(['pull_request', 'pull_request_target']);

/**
 * @param {string} login
 * @returns {'dependabot' | 'bot' | 'human'}
 */
function loginOrigin(login) {
  if (login === 'dependabot[bot]') return 'dependabot';
  return login.endsWith('[bot]') ? 'bot' : 'human';
}

/**
 * Who a pull request run is for when its pull request is not known: the run's actor (the person
 * or bot that pushed), with a `dependabot/` branch counting as Dependabot's.
 * @param {WorkflowRun} run
 * @returns {'dependabot' | 'bot' | 'human'}
 */
export function pullRequestOrigin(run) {
  if (String(run.head_branch ?? '').startsWith('dependabot/')) return 'dependabot';
  return loginOrigin(String(run.actor?.login ?? ''));
}

/**
 * Who triggered a run, for the report: a bot keeps its login (bots are what the report needs to
 * name); a person is `human`, so no one's login lands in a document.
 * @param {WorkflowRun} run
 * @returns {string}
 */
export function triggerOf(run) {
  const login = String(run.triggering_actor?.login ?? run.actor?.login ?? '');
  return login.endsWith('[bot]') ? login : 'human';
}

/**
 * The pull request a merge-queue run is testing, from `gh-readonly-queue/<base>/pr-<n>-<sha>`.
 * @param {string | null | undefined} headBranch
 * @returns {number | null}
 */
export function mergeQueuePr(headBranch) {
  const match = /^gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]+$/u.exec(headBranch ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * The pull request number GitHub attached to a run. The API leaves `pull_requests` empty for most
 * runs of this repository, so {@link resolveRuns} falls back to the pull request listing.
 * @param {WorkflowRun} run
 * @returns {number | null}
 */
export function pullRequestNumber(run) {
  const number = run.pull_requests?.[0]?.number;
  return typeof number === 'number' ? number : null;
}

/**
 * Which pull request a run belongs to, and who it is for.
 * @typedef {object} ResolvedRun
 * @property {WorkflowRun} run
 * @property {number | null} pr
 * @property {string} origin dependabot | human | bot | unknown (merge-queue PR not found) | automation
 */

/**
 * Attach each run to its pull request: the number GitHub attached, or else the pull request whose
 * head branch the run built and which was open when the run was created (the latest opened, when
 * a branch was reused). Origin comes from the pull request's author when known.
 * @param {readonly WorkflowRun[]} runs
 * @param {readonly PullRequest[]} [pulls]
 * @returns {ResolvedRun[]}
 */
export function resolveRuns(runs, pulls = []) {
  /** @type {Map<string, PullRequest[]>} */
  const byBranch = new Map();
  /** @type {Map<number, PullRequest>} */
  const byNumber = new Map();
  for (const pull of pulls) {
    byNumber.set(pull.number, pull);
    const list = byBranch.get(pull.headRef);
    if (list) list.push(pull);
    else byBranch.set(pull.headRef, [pull]);
  }
  /** @param {WorkflowRun} run */
  const fromBranch = (run) => {
    const created = Date.parse(run.created_at ?? run.run_started_at ?? '');
    const candidates = (byBranch.get(run.head_branch ?? '') ?? []).filter(
      (pull) =>
        Date.parse(pull.createdAt) <= created &&
        (pull.closedAt === null || Date.parse(pull.closedAt) >= created),
    );
    candidates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return candidates[0]?.number ?? null;
  };
  /** @param {number | null} pr */
  const authorOrigin = (pr) => {
    const author = pr === null ? undefined : byNumber.get(pr)?.author;
    return author === undefined ? null : loginOrigin(author);
  };

  /** @type {Map<number, string>} */
  const prOrigin = new Map();
  const resolved = runs.map((run) => {
    /** @type {number | null} */
    let pr = null;
    let origin = 'automation';
    if (PR_EVENTS.has(run.event)) {
      pr = pullRequestNumber(run) ?? fromBranch(run);
      origin = authorOrigin(pr) ?? pullRequestOrigin(run);
      if (pr !== null) prOrigin.set(pr, origin);
    } else if (run.event === 'merge_group') {
      pr = mergeQueuePr(run.head_branch);
      origin = 'unknown';
    }
    return { run, pr, origin };
  });
  for (const entry of resolved) {
    if (entry.run.event !== 'merge_group' || entry.pr === null) continue;
    entry.origin = authorOrigin(entry.pr) ?? prOrigin.get(entry.pr) ?? 'unknown';
  }
  return resolved;
}

/**
 * @typedef {object} JobRecord
 * @property {number} runId
 * @property {string} workflow
 * @property {string} event
 * @property {string} origin dependabot | human | bot | unknown (merge queue PR not seen) | automation
 * @property {number | null} pr
 * @property {string} job
 * @property {string} runnerClass
 * @property {string} runnerGroup
 * @property {string | null} conclusion
 * @property {number} seconds
 * @property {number} minutes billed minutes (each job rounded up to a whole minute)
 * @property {number} usd
 */

/**
 * @typedef {object} RunRecord
 * @property {number} id
 * @property {string} workflow
 * @property {string} path
 * @property {string} event
 * @property {string} origin
 * @property {number | null} pr
 * @property {string | null} conclusion
 * @property {number | null} wallSeconds start of the latest attempt to completion
 * @property {string} headSha
 * @property {string} trigger who triggered the run: a bot's login, or `human`
 */

/**
 * Flatten runs and their jobs into one record per job.
 * @param {readonly WorkflowRun[]} runs
 * @param {Map<number, WorkflowJob[]>} jobsByRun
 * @param {readonly PullRequest[]} [pulls]
 * @returns {{runs: RunRecord[], jobs: JobRecord[]}}
 */
export function buildRecords(runs, jobsByRun, pulls = []) {
  /** @type {RunRecord[]} */
  const runRecords = [];
  /** @type {JobRecord[]} */
  const jobRecords = [];
  for (const { run, pr, origin } of resolveRuns(runs, pulls)) {
    if (run.status !== 'completed') continue;
    const workflow = String(run.name ?? run.path ?? 'unknown');
    runRecords.push({
      id: run.id,
      workflow,
      path: String(run.path ?? ''),
      event: run.event,
      origin,
      pr,
      conclusion: run.conclusion ?? null,
      wallSeconds: spanSeconds(run.run_started_at, run.updated_at),
      headSha: String(run.head_sha ?? ''),
      trigger: triggerOf(run),
    });
    for (const job of jobsByRun.get(run.id) ?? []) {
      if (job.status !== 'completed') continue;
      const ran = job.conclusion !== 'skipped';
      const seconds = (ran && spanSeconds(job.started_at, job.completed_at)) || 0;
      const cls = runnerClass(job.labels);
      const minutes = Math.ceil(seconds / 60);
      jobRecords.push({
        runId: run.id,
        workflow,
        event: run.event,
        origin,
        pr,
        job: String(job.name),
        runnerClass: cls,
        runnerGroup: runnerGroup(cls),
        conclusion: job.conclusion ?? null,
        seconds,
        minutes,
        usd: minutes * pricePerMinute(cls),
      });
    }
  }
  return { runs: runRecords, jobs: jobRecords };
}

/**
 * Group `items` by a string key.
 * @template T
 * @param {readonly T[]} items
 * @param {(item: T) => string} key
 * @returns {Map<string, T[]>}
 */
function groupBy(items, key) {
  /** @type {Map<string, T[]>} */
  const groups = new Map();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

/** @param {readonly JobRecord[]} jobs */
const sumMinutes = (jobs) => jobs.reduce((total, job) => total + job.minutes, 0);
/** @param {readonly JobRecord[]} jobs */
const sumUsd = (jobs) =>
  round(
    jobs.reduce((total, job) => total + job.usd, 0),
    2,
  );

/**
 * @param {number} value
 * @param {number} digits
 */
export function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Run conclusions whose wall clock is a real end-to-end time (a cancelled run stopped early). */
const FINISHED = new Set(['success', 'failure']);

/**
 * @typedef {object} ReportInput
 * @property {string} repo
 * @property {Date} from
 * @property {Date} to
 * @property {readonly WorkflowRun[]} runs
 * @property {Map<number, WorkflowJob[]>} jobsByRun
 * @property {readonly PullRequest[]} [pulls] the repository's pull requests, to attach runs to them
 * @property {Map<number, string[]>} [pullFiles] changed paths per PR, for the docs-only split
 * @property {string} [prWallWorkflowPath] the workflow whose PR wall clock the docs/code split
 *   reports (default `.github/workflows/ci.yml`, the one carrying `CI success`)
 */

/**
 * The whole report as plain data.
 * @param {ReportInput} input
 */
export function aggregate(input) {
  const { runs, jobs } = buildRecords(input.runs, input.jobsByRun, input.pulls);
  const days = (input.to.getTime() - input.from.getTime()) / 86_400_000;
  const perWeek = (/** @type {number} */ value) => round((value * 7) / days, 1);
  const ran = jobs.filter((job) => job.conclusion !== 'skipped');

  const byRunnerClass = [...groupBy(jobs, (job) => job.runnerClass)]
    .map(([cls, list]) => ({
      runnerClass: cls,
      runnerGroup: runnerGroup(cls),
      usdPerMinute: pricePerMinute(cls),
      jobs: list.filter((job) => job.conclusion !== 'skipped').length,
      minutes: sumMinutes(list),
      minutesPerWeek: perWeek(sumMinutes(list)),
      usd: sumUsd(list),
      usdPerWeek: round((sumUsd(list) * 7) / days, 2),
    }))
    .sort((a, b) => b.minutes - a.minutes);

  const byRunnerGroup = RUNNER_GROUPS.map((group) => {
    const list = jobs.filter((job) => job.runnerGroup === group);
    return {
      runnerGroup: group,
      minutes: sumMinutes(list),
      minutesPerWeek: perWeek(sumMinutes(list)),
      usd: sumUsd(list),
      usdPerWeek: round((sumUsd(list) * 7) / days, 2),
    };
  });

  const jobsByRun = groupBy(jobs, (job) => String(job.runId));
  const byWorkflowEvent = [...groupBy(runs, (run) => `${run.workflow}\u0000${run.event}`)]
    .map(([, list]) => {
      const first = /** @type {RunRecord} */ (list[0]);
      const listJobs = list.flatMap((run) => jobsByRun.get(String(run.id)) ?? []);
      const walls = list
        .filter((run) => FINISHED.has(String(run.conclusion)) && run.wallSeconds !== null)
        .map((run) => /** @type {number} */ (run.wallSeconds));
      return {
        workflow: first.workflow,
        event: first.event,
        runs: list.length,
        runsWithJobs: list.filter((run) => jobsByRun.has(String(run.id))).length,
        cancelledRuns: list.filter((run) => run.conclusion === 'cancelled').length,
        minutes: sumMinutes(listJobs),
        usd: sumUsd(listJobs),
        cancelledMinutes: sumMinutes(listJobs.filter((job) => job.conclusion === 'cancelled')),
        wallP50Seconds: percentile(walls, 50),
        wallP90Seconds: percentile(walls, 90),
      };
    })
    .sort((a, b) => b.minutes - a.minutes);

  const byJob = [
    ...groupBy(ran, (job) => [job.workflow, job.event, job.job, job.runnerClass].join('\u0000')),
  ]
    .map(([, list]) => {
      const first = /** @type {JobRecord} */ (list[0]);
      const finished = list.filter(
        (job) => job.conclusion === 'success' || job.conclusion === 'failure',
      );
      const seconds = finished.map((job) => job.seconds);
      return {
        workflow: first.workflow,
        event: first.event,
        job: first.job,
        runnerClass: first.runnerClass,
        count: list.length,
        minutes: sumMinutes(list),
        usd: sumUsd(list),
        p50Seconds: percentile(seconds, 50),
        p90Seconds: percentile(seconds, 90),
      };
    })
    .sort((a, b) => b.minutes - a.minutes);

  const byOrigin = [
    ...groupBy(
      runs.filter((run) => PR_EVENTS.has(run.event) || run.event === 'merge_group'),
      (run) => `${run.event}\u0000${run.origin}`,
    ),
  ]
    .map(([, list]) => {
      const first = /** @type {RunRecord} */ (list[0]);
      const listJobs = list.flatMap((run) => jobsByRun.get(String(run.id)) ?? []);
      return {
        event: first.event,
        origin: first.origin,
        runs: list.length,
        pullRequests: new Set(list.map((run) => run.pr).filter((pr) => pr !== null)).size,
        minutes: sumMinutes(listJobs),
        usd: sumUsd(listJobs),
      };
    })
    .sort((a, b) => b.minutes - a.minutes);

  // A merge-queue job is a duplicate when the same workflow × job already ran on that PR.
  const prJobs = new Set(
    ran
      .filter((job) => PR_EVENTS.has(job.event) && job.pr !== null)
      .map((job) => [job.pr, job.workflow, job.job].join('\u0000')),
  );
  const mergeGroupJobs = jobs.filter((job) => job.event === 'merge_group');
  const duplicates = mergeGroupJobs.filter((job) =>
    prJobs.has([job.pr, job.workflow, job.job].join('\u0000')),
  );
  const mergeGroup = {
    minutes: sumMinutes(mergeGroupJobs),
    usd: sumUsd(mergeGroupJobs),
    duplicateMinutes: sumMinutes(duplicates),
    duplicateUsd: sumUsd(duplicates),
    byWorkflow: [...groupBy(duplicates, (job) => job.workflow)]
      .map(([workflow, list]) => ({
        workflow,
        duplicateMinutes: sumMinutes(list),
        usd: sumUsd(list),
      }))
      .sort((a, b) => b.duplicateMinutes - a.duplicateMinutes),
  };

  const cancelledJobs = jobs.filter((job) => job.conclusion === 'cancelled');
  const cancelled = {
    jobs: cancelledJobs.length,
    minutes: sumMinutes(cancelledJobs),
    usd: sumUsd(cancelledJobs),
  };

  const wallPath = input.prWallWorkflowPath ?? '.github/workflows/ci.yml';
  // One sample per pushed head: the longest finished run of the workflow for that PR and SHA, which
  // is when the author saw every check of that push finish (a second run of the same SHA, e.g. from
  // an `edited` event, would otherwise count as a separate, shorter "PR").
  /** @param {readonly RunRecord[]} list */
  const wallStats = (list) => {
    /** @type {Map<string, number>} */
    const heads = new Map();
    for (const run of list) {
      const key = `${run.pr}\u0000${run.headSha}`;
      heads.set(key, Math.max(heads.get(key) ?? 0, /** @type {number} */ (run.wallSeconds)));
    }
    const walls = [...heads.values()];
    return {
      heads: walls.length,
      pullRequests: new Set(list.map((run) => run.pr)).size,
      p50Seconds: percentile(walls, 50),
      p90Seconds: percentile(walls, 90),
    };
  };
  const prRuns = runs.filter(
    (run) =>
      run.path === wallPath &&
      PR_EVENTS.has(run.event) &&
      run.origin === 'human' &&
      run.pr !== null &&
      FINISHED.has(String(run.conclusion)) &&
      run.wallSeconds !== null &&
      input.pullFiles?.has(run.pr),
  );
  const docsOnly = (/** @type {RunRecord} */ run) =>
    isDocsOnly(input.pullFiles?.get(/** @type {number} */ (run.pr)) ?? []);
  const prWall = {
    workflowPath: wallPath,
    docsOnly: wallStats(prRuns.filter(docsOnly)),
    code: wallStats(prRuns.filter((run) => !docsOnly(run))),
  };

  // Pull request runs of a workflow beyond the first for the same head SHA: the same commit tested
  // again (an `edited`/`reopened` event, a re-trigger by a bot). Minutes counted are those of every
  // run but the costliest one of each SHA.
  const repeatGroups = [
    ...groupBy(
      runs.filter((run) => PR_EVENTS.has(run.event) && run.headSha !== ''),
      (run) => `${run.workflow}\u0000${run.headSha}`,
    ).values(),
  ].filter((list) => list.length > 1);
  /** @type {Map<string, {runs: number, minutes: number}>} */
  const repeatTriggers = new Map();
  let repeatRuns = 0;
  let repeatMinutes = 0;
  let repeatUsd = 0;
  for (const list of repeatGroups) {
    const costs = list
      .map((run) => {
        const runJobs = jobsByRun.get(String(run.id)) ?? [];
        return { run, minutes: sumMinutes(runJobs), usd: runJobs.reduce((t, j) => t + j.usd, 0) };
      })
      .sort((a, b) => b.minutes - a.minutes);
    for (const extra of costs.slice(1)) {
      repeatRuns += 1;
      repeatMinutes += extra.minutes;
      repeatUsd += extra.usd;
    }
    // Attribute each SHA's later runs (by start time) to whoever triggered them.
    const byStart = [...list].sort((a, b) => a.id - b.id);
    for (const run of byStart.slice(1)) {
      const row = repeatTriggers.get(run.trigger) ?? { runs: 0, minutes: 0 };
      row.runs += 1;
      row.minutes += sumMinutes(jobsByRun.get(String(run.id)) ?? []);
      repeatTriggers.set(run.trigger, row);
    }
  }
  const prRepeats = {
    shas: repeatGroups.length,
    extraRuns: repeatRuns,
    minutes: repeatMinutes,
    usd: round(repeatUsd, 2),
    laterRunsByTrigger: [...repeatTriggers]
      .map(([trigger, row]) => ({ trigger, ...row }))
      .sort((a, b) => b.minutes - a.minutes),
  };

  return {
    repo: input.repo,
    window: { from: input.from.toISOString(), to: input.to.toISOString(), days: round(days, 2) },
    priceTable: PRICE_TABLE,
    totals: {
      runs: runs.length,
      jobs: ran.length,
      minutes: sumMinutes(jobs),
      minutesPerWeek: perWeek(sumMinutes(jobs)),
      usd: sumUsd(jobs),
      usdPerWeek: round((sumUsd(jobs) * 7) / days, 2),
    },
    byRunnerGroup,
    byRunnerClass,
    byWorkflowEvent,
    byJob,
    byOrigin,
    mergeGroup,
    cancelled,
    prWall,
    prRepeats,
  };
}

/** @typedef {ReturnType<typeof aggregate>} Report */

/**
 * The human pull request numbers whose changed files the docs-only split needs: those with a
 * completed pull request run of the wall-clock workflow.
 * @param {readonly WorkflowRun[]} runs
 * @param {readonly PullRequest[]} [pulls]
 * @param {string} [workflowPath]
 * @returns {number[]}
 */
export function pullRequestsToClassify(
  runs,
  pulls = [],
  workflowPath = '.github/workflows/ci.yml',
) {
  const numbers = new Set();
  for (const { run, pr, origin } of resolveRuns(runs, pulls)) {
    if (run.path !== workflowPath || !PR_EVENTS.has(run.event) || run.status !== 'completed')
      continue;
    if (origin === 'human' && pr !== null) numbers.add(pr);
  }
  return [...numbers].sort((a, b) => a - b);
}
