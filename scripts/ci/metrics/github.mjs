// The GitHub side of the CI metrics report: workflow runs, their jobs and (for pull requests) the
// changed files, read through `gh api`. Node built-ins only; `gh` supplies the token.
//
// The run listing returns at most 1000 results per query whatever its `total_count` says, so the
// window is split into slices until every slice holds fewer than 1000 runs. A completed run never
// changes, so its jobs (and a pull request's files) are cached on disk by id: a report that hits
// the rate limit can be re-run and picks up where it stopped.

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The fields of a GitHub Actions workflow run (`GET /repos/{o}/{r}/actions/runs`) the report reads.
 * @typedef {object} WorkflowRun
 * @property {number} id
 * @property {string | null} [name]
 * @property {string | null} [path]
 * @property {string} event
 * @property {string | null} status
 * @property {string | null} conclusion
 * @property {number | undefined} [run_attempt]
 * @property {string | null} [head_branch]
 * @property {string | null} [run_started_at]
 * @property {string | null} [created_at]
 * @property {string | null} [updated_at]
 * @property {string | null} [head_sha]
 * @property {{login?: string} | null} [actor]
 * @property {{login?: string} | null} [triggering_actor]
 * @property {Array<{number: number}> | null} [pull_requests]
 */

/**
 * The fields of a workflow job (`GET …/actions/runs/{id}/jobs`) the report reads.
 * @typedef {object} WorkflowJob
 * @property {number} id
 * @property {number | undefined} [run_attempt]
 * @property {string} name
 * @property {string | null} status
 * @property {string | null} conclusion
 * @property {string | null} started_at
 * @property {string | null} completed_at
 * @property {string[] | null} labels
 * @property {string | null | undefined} [runner_name]
 */

/** The listing endpoint's hard result cap. */
const LISTING_CAP = 1000;
const PER_PAGE = 100;
const CONCURRENCY = 8;

/**
 * @typedef {(endpoint: string) => Promise<unknown>} GhApi
 * Calls one `gh api` endpoint (relative, e.g. `repos/o/r/actions/runs?...`) and returns its JSON.
 */

/**
 * Attempts per call on a server error (5xx) or a failed connection, both seen while measuring the
 * baseline (a 502, "no route to host", "error connecting to api.github.com"). A 4xx — including
 * the rate limit — is never retried: it would fail the same way again.
 */
const TRANSIENT_ATTEMPTS = 4;
const TRANSIENT =
  /\(HTTP 5\d\d\)|dial tcp|connection reset|i\/o timeout|unexpected EOF|TLS handshake|error connecting to/u;

/**
 * A pull request, reduced to what attaches runs to it.
 * @typedef {object} PullRequest
 * @property {number} number
 * @property {string} headRef
 * @property {string} author
 * @property {string} createdAt
 * @property {string | null} closedAt
 */

/** @type {GhApi} */
export async function ghApi(endpoint) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['api', '-H', 'Accept: application/vnd.github+json', endpoint],
        {
          maxBuffer: 256 * 1024 * 1024,
        },
      );
      return JSON.parse(stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= TRANSIENT_ATTEMPTS || !TRANSIENT.test(message)) throw error;
      await sleep(2000 * attempt);
    }
  }
}

/**
 * Split [from, to) into `parts` equal slices.
 * @param {Date} from
 * @param {Date} to
 * @param {number} parts
 * @returns {Array<[Date, Date]>}
 */
export function splitWindow(from, to, parts) {
  const step = (to.getTime() - from.getTime()) / parts;
  /** @type {Array<[Date, Date]>} */
  const slices = [];
  for (let index = 0; index < parts; index += 1) {
    const start = new Date(Math.round(from.getTime() + step * index));
    const end =
      index === parts - 1 ? to : new Date(Math.round(from.getTime() + step * (index + 1)));
    slices.push([start, end]);
  }
  return slices;
}

/**
 * The `created` qualifier for [from, to): GitHub's range is inclusive at both ends, so the end is
 * one second earlier.
 * @param {Date} from
 * @param {Date} to
 * @returns {string}
 */
export function createdRange(from, to) {
  const iso = (/** @type {Date} */ date) => date.toISOString().replace(/\.\d{3}Z$/u, 'Z');
  return `${iso(from)}..${iso(new Date(to.getTime() - 1000))}`;
}

/**
 * Every workflow run created in [from, to).
 * @param {GhApi} api
 * @param {string} repo `owner/name`
 * @param {Date} from
 * @param {Date} to
 * @returns {Promise<WorkflowRun[]>}
 */
export async function listRuns(api, repo, from, to) {
  const base = `repos/${repo}/actions/runs?created=${encodeURIComponent(createdRange(from, to))}`;
  const first = /** @type {{total_count: number, workflow_runs: WorkflowRun[]}} */ (
    await api(`${base}&per_page=${PER_PAGE}&page=1`)
  );
  if (first.total_count >= LISTING_CAP) {
    if (to.getTime() - from.getTime() <= 60_000) {
      throw new Error(`more than ${LISTING_CAP} runs in one minute from ${from.toISOString()}`);
    }
    const halves = await Promise.all(
      splitWindow(from, to, 2).map(([start, end]) => listRuns(api, repo, start, end)),
    );
    return halves.flat();
  }
  const runs = [...first.workflow_runs];
  const pages = Math.ceil(first.total_count / PER_PAGE);
  for (let page = 2; page <= pages; page += 1) {
    const next = /** @type {{workflow_runs: WorkflowRun[]}} */ (
      await api(`${base}&per_page=${PER_PAGE}&page=${page}`)
    );
    runs.push(...next.workflow_runs);
  }
  return runs;
}

/**
 * Run `task` over `items`, at most `limit` at a time.
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} task
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, task) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await task(/** @type {T} */ (items[index]));
      } catch (error) {
        // Stop the other workers taking new items: the call has failed as a whole.
        next = items.length;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Read `key` from the cache directory, or compute and store it.
 * @param {string | undefined} cacheDir
 * @param {string} key
 * @param {() => Promise<unknown>} compute
 * @returns {Promise<any>} parsed JSON the caller typed when it stored it
 */
async function cached(cacheDir, key, compute) {
  if (!cacheDir) return compute();
  const file = path.join(cacheDir, `${key}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    const value = await compute();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value));
    return value;
  }
}

/**
 * Every job of every attempt of a run (`filter=all`), paginated.
 * @param {GhApi} api
 * @param {string} repo
 * @param {number} runId
 * @returns {Promise<WorkflowJob[]>}
 */
async function listJobs(api, repo, runId) {
  /** @type {WorkflowJob[]} */
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const body = /** @type {{total_count: number, jobs: WorkflowJob[]}} */ (
      await api(
        `repos/${repo}/actions/runs/${runId}/jobs?filter=all&per_page=${PER_PAGE}&page=${page}`,
      )
    );
    jobs.push(...body.jobs);
    if (jobs.length >= body.total_count || body.jobs.length === 0) return jobs;
  }
}

/**
 * Keep only the job fields the report reads, so the cache stays small.
 * @param {WorkflowJob} job
 * @returns {WorkflowJob}
 */
function slimJob(job) {
  return {
    id: job.id,
    run_attempt: job.run_attempt,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    labels: job.labels,
    runner_name: job.runner_name,
  };
}

/**
 * Whether a run needs its jobs fetched: a run that never started a job (skipped, or a workflow
 * file that failed to parse) has none, and a run still going is left out of the report.
 * @param {WorkflowRun} run
 */
export function runHasJobs(run) {
  return (
    run.status === 'completed' &&
    run.conclusion !== 'skipped' &&
    run.conclusion !== 'startup_failure'
  );
}

/**
 * The jobs of every completed run, keyed by run id.
 * @param {GhApi} api
 * @param {string} repo
 * @param {readonly WorkflowRun[]} runs
 * @param {string | undefined} cacheDir
 * @returns {Promise<Map<number, WorkflowJob[]>>}
 */
export async function fetchJobs(api, repo, runs, cacheDir) {
  const wanted = runs.filter(runHasJobs);
  const lists = await mapLimit(wanted, CONCURRENCY, (run) =>
    cached(cacheDir, `jobs/${run.id}-${run.run_attempt}`, async () =>
      (await listJobs(api, repo, run.id)).map(slimJob),
    ),
  );
  return new Map(wanted.map((run, index) => [run.id, lists[index] ?? []]));
}

/**
 * The changed paths of each pull request (up to the API's 3000-file cap; a PR that large is not
 * docs-only anyway).
 * @param {GhApi} api
 * @param {string} repo
 * @param {readonly number[]} numbers
 * @param {string | undefined} cacheDir
 * @returns {Promise<Map<number, string[]>>}
 */
export async function fetchPullFiles(api, repo, numbers, cacheDir) {
  const lists = await mapLimit(numbers, CONCURRENCY, (number) =>
    cached(cacheDir, `pulls/${number}`, async () => {
      /** @type {string[]} */
      const files = [];
      for (let page = 1; page <= 30; page += 1) {
        const body = /** @type {Array<{filename: string}>} */ (
          await api(`repos/${repo}/pulls/${number}/files?per_page=${PER_PAGE}&page=${page}`)
        );
        files.push(...body.map((file) => file.filename));
        if (body.length < PER_PAGE) break;
      }
      return files;
    }),
  );
  return new Map(numbers.map((number, index) => [number, lists[index] ?? []]));
}

/**
 * Every pull request updated since `since` (open or closed), newest update first. Runs of a pull
 * request created before `since` belong to one updated after it, so this covers the window.
 * @param {GhApi} api
 * @param {string} repo
 * @param {Date} since
 * @returns {Promise<PullRequest[]>}
 */
export async function listPulls(api, repo, since) {
  /** @type {PullRequest[]} */
  const pulls = [];
  for (let page = 1; ; page += 1) {
    const body =
      /** @type {Array<{number: number, head: {ref: string}, user: {login: string} | null, created_at: string, closed_at: string | null, updated_at: string}>} */ (
        await api(
          `repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${page}`,
        )
      );
    for (const pull of body) {
      if (Date.parse(pull.updated_at) < since.getTime()) return pulls;
      pulls.push({
        number: pull.number,
        headRef: pull.head.ref,
        author: pull.user?.login ?? '',
        createdAt: pull.created_at,
        closedAt: pull.closed_at,
      });
    }
    if (body.length < PER_PAGE) return pulls;
  }
}
