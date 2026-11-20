/**
 * The CI metrics report (`scripts/ci/metrics/`), held to recorded fixtures: no network.
 *
 * `fixtures/runs.json` and `fixtures/jobs.json` keep the shape of the GitHub Actions API's run and
 * job objects (logins and SHAs replaced). Every expected number below is worked out by hand from
 * them in the comments, so a change to a definition (billed minutes, the duplicate rule, the
 * docs-only rule, a price) fails here with the figure it moved.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  aggregate,
  isDocsOnly,
  mergeQueuePr,
  percentile,
  pricePerMinute,
  pullRequestsToClassify,
  resolveRuns,
  runnerClass,
  triggerOf,
} from '../../scripts/ci/metrics/aggregate.mjs';
import { checkBudget, parseBudget } from '../../scripts/ci/metrics/budget.mjs';
import {
  createdRange,
  fetchJobs,
  listPulls,
  listRuns,
  splitWindow,
} from '../../scripts/ci/metrics/github.mjs';
import type { WorkflowJob, WorkflowRun } from '../../scripts/ci/metrics/github.mjs';
import { renderCheck, renderMarkdown } from '../../scripts/ci/metrics/render.mjs';
import { parseCli } from '../../scripts/ci/metrics/report.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(path.join(import.meta.dirname, 'fixtures', name), 'utf8'));

async function loadFixtures() {
  const runs = (await fixture('runs.json')) as WorkflowRun[];
  const jobs = (await fixture('jobs.json')) as Record<string, WorkflowJob[]>;
  const jobsByRun = new Map(Object.entries(jobs).map(([id, list]) => [Number(id), list]));
  const pullFiles = new Map<number, string[]>([
    [10, ['apps/web/src/widget.ts', 'docs/widget.md']],
    [11, ['docs/guide.md', 'changes/typo.md']],
  ]);
  const report = aggregate({
    repo: 'example/repo',
    from: new Date('2026-11-08T00:00:00Z'),
    to: new Date('2026-11-15T00:00:00Z'),
    runs,
    jobsByRun,
    pullFiles,
  });
  return { runs, jobsByRun, report };
}

describe('runner classes and prices', () => {
  it('classifies the runs-on labels this repository uses', () => {
    expect(runnerClass(['blacksmith-2vcpu-ubuntu-2404'])).toBe('blacksmith-2vcpu');
    expect(runnerClass(['blacksmith-8vcpu-ubuntu-2404'])).toBe('blacksmith-8vcpu');
    expect(runnerClass(['blacksmith-4vcpu-ubuntu-2404-arm'])).toBe('blacksmith-4vcpu-arm');
    expect(runnerClass(['blacksmith-4vcpu-windows-2025'])).toBe('blacksmith-4vcpu-windows');
    expect(runnerClass(['blacksmith-6vcpu-macos-latest'])).toBe('blacksmith-6vcpu-macos');
    expect(runnerClass(['ubuntu-latest'])).toBe('github-hosted');
    expect(runnerClass(['ubuntu-24.04-arm'])).toBe('github-hosted-arm');
    expect(runnerClass(['windows-latest'])).toBe('github-hosted-windows');
    expect(runnerClass(['self-hosted', 'ms-a2'])).toBe('self-hosted');
    expect(runnerClass(['self-hosted', 'docker'])).toBe('self-hosted');
    expect(runnerClass([])).toBe('unassigned');
    expect(runnerClass(['some-larger-runner'])).toBe('other');
  });

  it('prices Blacksmith x64 at $0.004/min for 2 vCPU, doubling per size, ARM 37 % cheaper', () => {
    expect(pricePerMinute('blacksmith-2vcpu')).toBeCloseTo(0.004);
    expect(pricePerMinute('blacksmith-4vcpu')).toBeCloseTo(0.008);
    expect(pricePerMinute('blacksmith-8vcpu')).toBeCloseTo(0.016);
    expect(pricePerMinute('blacksmith-16vcpu')).toBeCloseTo(0.032);
    expect(pricePerMinute('blacksmith-2vcpu-arm')).toBeCloseTo(0.00252);
    expect(pricePerMinute('blacksmith-4vcpu-windows')).toBeCloseTo(0.016);
    expect(pricePerMinute('github-hosted')).toBeCloseTo(0.006);
    expect(pricePerMinute('blacksmith-6vcpu-macos')).toBe(0);
    expect(pricePerMinute('self-hosted')).toBe(0);
    expect(pricePerMinute('other')).toBe(0);
  });
});

describe('small rules', () => {
  it('takes nearest-rank percentiles', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([600, 300, 480], 50)).toBe(480);
    expect(percentile([600, 300, 480], 90)).toBe(600);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });

  it('reads the PR a merge-queue branch is testing', () => {
    expect(
      mergeQueuePr('gh-readonly-queue/main/pr-2350-9b2bdb23e0123456789abcdef0123456789abcde'),
    ).toBe(2350);
    expect(mergeQueuePr('main')).toBeNull();
    expect(mergeQueuePr(null)).toBeNull();
  });

  it('calls a PR docs-only only when every path is docs, markdown or a change fragment', () => {
    expect(isDocsOnly(['docs/a.md', 'changes/x.md', 'README.md', 'docs/img.png'])).toBe(true);
    expect(isDocsOnly(['docs/a.md', 'scripts/x.mjs'])).toBe(false);
    expect(isDocsOnly([])).toBe(false);
  });
});

describe('aggregate over the recorded fixtures', () => {
  it('bills each job in whole minutes and splits them by runner group', async () => {
    const { report } = await loadFixtures();
    // 9 completed runs (the in-progress one is left out); 11 jobs ran (one skipped).
    expect(report.totals).toMatchObject({ runs: 9, jobs: 11, minutes: 58, minutesPerWeek: 58 });
    // 0.032+0.128+0.032+0.112+0.016+0.032+0.024+0.08+0.006+0.0252 = 0.4872
    expect(report.totals.usd).toBe(0.49);
    const groups = Object.fromEntries(
      report.byRunnerGroup.map((row) => [row.runnerGroup, row.minutes]),
    );
    expect(groups).toEqual({ blacksmith: 45, 'github-hosted': 1, 'self-hosted': 12, other: 0 });
    const classes = Object.fromEntries(
      report.byRunnerClass.map((row) => [row.runnerClass, row.minutes]),
    );
    expect(classes).toMatchObject({
      'blacksmith-4vcpu': 13,
      'blacksmith-8vcpu': 17,
      'blacksmith-4vcpu-windows': 5,
      'blacksmith-2vcpu-arm': 10,
    });
  });

  it('reports wall clock per workflow × event over finished runs only', async () => {
    const { report } = await loadFixtures();
    const ci = report.byWorkflowEvent.find(
      (row) => row.workflow === 'CI' && row.event === 'pull_request',
    );
    // Walls 600 s, 480 s and 300 s; the cancelled run (150 s) does not count.
    expect(ci).toMatchObject({
      runs: 4,
      cancelledRuns: 1,
      minutes: 27,
      cancelledMinutes: 2,
      wallP50Seconds: 480,
      wallP90Seconds: 600,
    });
  });

  it('reports p50/p90 per job and runner class, counting cancelled minutes but not their duration', async () => {
    const { report } = await loadFixtures();
    const tests = report.byJob.find(
      (row) => row.workflow === 'CI' && row.event === 'pull_request' && row.job === 'tests · tests',
    );
    expect(tests).toMatchObject({
      runnerClass: 'blacksmith-8vcpu',
      count: 3,
      minutes: 17,
      p50Seconds: 400,
      p90Seconds: 430,
    });
    expect(report.byJob.some((row) => row.job === 'trivy' && row.event === 'pull_request')).toBe(
      false,
    );
  });

  it('counts a merge-queue job as duplicate only when the same job ran on that PR', async () => {
    const { report } = await loadFixtures();
    // fast-checks (3 min) ran on PR 10; trivy was skipped there, so its 12 minutes are not a duplicate.
    expect(report.mergeGroup).toMatchObject({ minutes: 15, duplicateMinutes: 3 });
    expect(report.mergeGroup.byWorkflow).toEqual([
      { workflow: 'CI', duplicateMinutes: 3, usd: 0.02 },
    ]);
    expect(report.cancelled).toEqual({ jobs: 1, minutes: 2, usd: 0.03 });
  });

  it('separates dependabot from human PRs and follows a merge-queue run back to its PR', async () => {
    const { report } = await loadFixtures();
    const origins = report.byOrigin.map(({ event, origin, runs, pullRequests, minutes }) => ({
      event,
      origin,
      runs,
      pullRequests,
      minutes,
    }));
    expect(origins).toEqual([
      { event: 'pull_request', origin: 'human', runs: 4, pullRequests: 2, minutes: 30 },
      { event: 'merge_group', origin: 'human', runs: 1, pullRequests: 1, minutes: 15 },
      { event: 'pull_request', origin: 'dependabot', runs: 1, pullRequests: 1, minutes: 2 },
    ]);
  });

  it('splits human PR wall clock into docs-only and code', async () => {
    const { runs, report } = await loadFixtures();
    expect(pullRequestsToClassify(runs)).toEqual([10, 11]);
    expect(report.prWall.docsOnly).toEqual({
      heads: 1,
      pullRequests: 1,
      p50Seconds: 480,
      p90Seconds: 480,
    });
    expect(report.prWall.code).toEqual({
      heads: 1,
      pullRequests: 1,
      p50Seconds: 600,
      p90Seconds: 600,
    });
  });

  it('counts a second pull request run of the same head SHA as a repeat, by its trigger', async () => {
    const { report } = await loadFixtures();
    // Runs 101 (12 min) and 104 (2 min, re-triggered by a bot) tested the same SHA of PR 10.
    expect(report.prRepeats).toEqual({
      shas: 1,
      extraRuns: 1,
      minutes: 2,
      usd: 0.03,
      laterRunsByTrigger: [{ trigger: 'blacksmith-sh[bot]', runs: 1, minutes: 2 }],
    });
  });

  it('renders every section as markdown', async () => {
    const { report } = await loadFixtures();
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('#### By runner group');
    expect(markdown).toContain(
      '| CI | pull_request | tests · tests | blacksmith-8vcpu | 3 | 17 | $0.27 | 6m40s | 7m10s |',
    );
    expect(markdown).toContain('| docs-only | 1 | 1 | 8m00s | 8m00s |');
  });
});

describe('attaching runs to pull requests', () => {
  const run = (over: Partial<WorkflowRun>): WorkflowRun => ({
    id: 1,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'feat/reused',
    created_at: '2026-11-12T10:00:00Z',
    actor: { login: 'octocat' },
    pull_requests: [],
    ...over,
  });
  const pulls = [
    {
      number: 20,
      headRef: 'feat/reused',
      author: 'octocat',
      createdAt: '2026-11-01T00:00:00Z',
      closedAt: '2026-11-02T00:00:00Z',
    },
    {
      number: 21,
      headRef: 'feat/reused',
      author: 'octocat',
      createdAt: '2026-11-10T00:00:00Z',
      closedAt: null,
    },
    {
      number: 22,
      headRef: 'dependabot/npm/x',
      author: 'dependabot[bot]',
      createdAt: '2026-11-10T00:00:00Z',
      closedAt: null,
    },
  ];

  it('falls back to the PR open on the branch of the run when GitHub attached none', () => {
    const [reused, queued, bump, push] = resolveRuns(
      [
        run({ id: 1 }),
        run({
          id: 2,
          event: 'merge_group',
          head_branch: 'gh-readonly-queue/main/pr-22-abc123',
          actor: { login: 'github-merge-queue[bot]' },
        }),
        run({ id: 3, head_branch: 'dependabot/npm/x', actor: { login: 'blacksmith-sh[bot]' } }),
        run({ id: 4, event: 'push', head_branch: 'main' }),
      ],
      pulls,
    );
    expect(reused).toMatchObject({ pr: 21, origin: 'human' });
    // The queue run takes its origin from the PR's author, not from the merge queue bot.
    expect(queued).toMatchObject({ pr: 22, origin: 'dependabot' });
    expect(bump).toMatchObject({ pr: 22, origin: 'dependabot' });
    expect(push).toMatchObject({ pr: null, origin: 'automation' });
  });

  it('names bots that trigger runs and keeps people anonymous', () => {
    expect(triggerOf(run({ triggering_actor: { login: 'blacksmith-sh[bot]' } }))).toBe(
      'blacksmith-sh[bot]',
    );
    expect(triggerOf(run({ triggering_actor: { login: 'octocat' } }))).toBe('human');
  });

  it('lists pull requests updated since the window start, newest first, and stops there', async () => {
    const page = (start: number, count: number, updated: (i: number) => string) =>
      Array.from({ length: count }, (_, i) => ({
        number: start - i,
        head: { ref: `b${start - i}` },
        user: { login: 'octocat' },
        created_at: '2026-11-01T00:00:00Z',
        closed_at: null,
        updated_at: updated(i),
      }));
    const calls: string[] = [];
    const api = (endpoint: string) => {
      calls.push(endpoint);
      return Promise.resolve(
        endpoint.endsWith('page=1')
          ? page(300, 100, () => '2026-11-18T00:00:00Z')
          : page(200, 100, (i) => (i < 10 ? '2026-11-17T00:00:00Z' : '2026-11-01T00:00:00Z')),
      );
    };
    const found = await listPulls(api, 'example/repo', new Date('2026-11-11T00:00:00Z'));
    expect(found).toHaveLength(110);
    expect(found[0]).toEqual({
      number: 300,
      headRef: 'b300',
      author: 'octocat',
      createdAt: '2026-11-01T00:00:00Z',
      closedAt: null,
    });
    expect(calls).toHaveLength(2);
  });
});

describe('budget', () => {
  const doc = (json: string) =>
    `# Budget\n\n<!-- ci-budget:begin -->\n\`\`\`json\n${json}\n\`\`\`\n<!-- ci-budget:end -->\n`;

  it('flags each row above its ceiling and reports budgeted rows without data separately', async () => {
    const { report } = await loadFixtures();
    const budget = parseBudget(
      doc(
        JSON.stringify({
          minutesPerWeek: { blacksmith: 40, 'github-hosted': 5, 'blacksmith-8vcpu': 100 },
          jobP90Seconds: [
            { workflow: 'CI', job: 'tests · tests', p90Seconds: 420 },
            { workflow: 'CI', job: 'fast-checks', event: 'merge_group', p90Seconds: 180 },
            { workflow: 'CI', job: 'renamed job', p90Seconds: 60 },
          ],
          wallSeconds: [{ workflow: 'CI', event: 'merge_group', stat: 'p50', maxSeconds: 180 }],
          prWallP50Seconds: { docsOnly: 120, code: 600 },
        }),
      ),
    );
    const result = checkBudget(report, budget);
    expect(result.offending).toEqual([
      { kind: 'minutesPerWeek', key: 'blacksmith', actual: 45, limit: 40 },
      {
        kind: 'jobP90Seconds',
        key: 'CI / tests · tests (pull_request, blacksmith-8vcpu)',
        actual: 430,
        limit: 420,
      },
      { kind: 'wallSeconds', key: 'CI (merge_group) p50', actual: 900, limit: 180 },
      { kind: 'prWallP50Seconds', key: 'docsOnly', actual: 480, limit: 120 },
    ]);
    expect(result.missing).toEqual([
      { kind: 'jobP90Seconds', key: 'CI / renamed job', actual: null, limit: 60 },
    ]);
    expect(renderCheck(result)).toContain('CI budget exceeded on 4 row(s)');
  });

  it('passes a report inside every ceiling', async () => {
    const { report } = await loadFixtures();
    const budget = parseBudget(
      doc(JSON.stringify({ minutesPerWeek: { blacksmith: 45, 'self-hosted': 12 } })),
    );
    expect(checkBudget(report, budget).offending).toEqual([]);
  });

  it('rejects a malformed block instead of passing it', () => {
    expect(() => parseBudget('# nothing here')).toThrow(/no <!-- ci-budget:begin -->/u);
    expect(() => parseBudget(doc('{"minutesPerWeek": {"blacksmith": -1}}'))).toThrow(
      /non-negative/u,
    );
    expect(() => parseBudget(doc('{"minutesPerWek": {}}'))).toThrow(/unknown key/u);
    expect(() =>
      parseBudget(
        doc(
          '{"wallSeconds": [{"workflow": "CI", "event": "push", "stat": "p75", "maxSeconds": 1}]}',
        ),
      ),
    ).toThrow(/p50/u);
  });

  it('parses the budget block of docs/40-operate/operations/ci-budget.md', async () => {
    const budget = parseBudget(
      await readFile(path.join(ROOT, 'docs/40-operate/operations/ci-budget.md'), 'utf8'),
    );
    expect(Object.keys(budget.minutesPerWeek)).toEqual(
      expect.arrayContaining(['blacksmith', 'github-hosted']),
    );
    expect(budget.jobP90Seconds.length).toBeGreaterThan(0);
  });
});

describe('fetching', () => {
  it('splits a window whose listing would hit the 1000-result cap, and pages each slice', async () => {
    const from = new Date('2026-11-01T00:00:00Z');
    const to = new Date('2026-11-03T00:00:00Z');
    const calls: string[] = [];
    const api = (endpoint: string) => {
      calls.push(endpoint);
      const created = decodeURIComponent(/created=([^&]+)/u.exec(endpoint)?.[1] ?? '');
      const page = Number(/page=(\d+)$/u.exec(endpoint)?.[1]);
      if (created === createdRange(from, to))
        return Promise.resolve({ total_count: 1500, workflow_runs: [] });
      // Each one-day half holds 150 runs: two pages.
      const runs = Array.from({ length: page === 1 ? 100 : 50 }, (_, index) => ({
        id: `${created}#${page}#${index}`,
      }));
      return Promise.resolve({ total_count: 150, workflow_runs: runs });
    };
    const runs = await listRuns(api, 'example/repo', from, to);
    expect(runs).toHaveLength(300);
    expect(new Set(runs.map((run) => run.id)).size).toBe(300);
    expect(calls).toHaveLength(5);
    expect(splitWindow(from, to, 2).map(([start]) => start.toISOString())).toEqual([
      '2026-11-01T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
    ]);
    expect(createdRange(from, to)).toBe('2026-11-01T00:00:00Z..2026-11-02T23:59:59Z');
  });

  it('fetches jobs only for completed runs that started jobs, and serves repeats from the cache', async () => {
    const runs = (await fixture('runs.json')) as WorkflowRun[];
    const jobs = (await fixture('jobs.json')) as Record<string, WorkflowJob[]>;
    const calls: string[] = [];
    const api = (endpoint: string) => {
      calls.push(endpoint);
      const id = /runs\/(\d+)\/jobs/u.exec(endpoint)?.[1] ?? '';
      const list = jobs[id] ?? [];
      return Promise.resolve({ total_count: list.length, jobs: list });
    };
    const cacheDir = await mkdtemp(path.join(tmpdir(), 'ci-metrics-'));
    try {
      const first = await fetchJobs(api, 'example/repo', runs, cacheDir);
      // 10 runs: the skipped one (108) and the in-progress one (109) are not fetched.
      expect(calls).toHaveLength(8);
      expect(first.get(101)?.map((job) => job.name)).toEqual([
        'fast-checks',
        'tests · tests',
        'trivy',
      ]);
      const second = await fetchJobs(api, 'example/repo', runs, cacheDir);
      expect(calls).toHaveLength(8);
      expect(second).toEqual(first);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('command line', () => {
  it('accepts the interface the weekly workflow calls', () => {
    const options = parseCli([
      '--days',
      '7',
      '--repo',
      'example-org/example-repo',
      '--check',
      '--budget',
      'docs/40-operate/operations/ci-budget.md',
    ]);
    expect(options).toMatchObject({
      days: 7,
      repo: 'example-org/example-repo',
      check: true,
      format: 'markdown',
    });
    expect(parseCli(['--days', '14', '--json']).format).toBe('json');
  });

  it('refuses inputs it cannot honour', () => {
    expect(() => parseCli([])).toThrow(/--days/u);
    expect(() => parseCli(['--days', '7', '--check'])).toThrow(/--budget/u);
    expect(() => parseCli(['--days', '7', '--json', '--markdown'])).toThrow(/exclusive/u);
    expect(() => parseCli(['--days', '7', '--repo', 'not a repo'])).toThrow(/owner\/name/u);
    expect(() => parseCli(['--days', '7', '--surprise'])).toThrow();
  });
});
