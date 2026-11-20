#!/usr/bin/env node
// CI minutes, cost and wall clock for the last N days, from the GitHub Actions API.
//
//   node scripts/ci/metrics/report.mjs --days <n> [--repo <owner/name>] [--json|--markdown]
//                                      [--check --budget docs/40-operate/operations/ci-budget.md]
//                                      [--to <ISO time>] [--cache-dir <dir>]
//
// --repo defaults to $GITHUB_REPOSITORY, then to the repository `gh` resolves for the current
// directory. --markdown (the default) prints tables; --json prints the whole report. --check holds
// the report to the budget block of --budget and exits 1, printing the offending rows, when any
// ceiling is exceeded. --cache-dir keeps fetched jobs and PR file lists between runs (completed
// runs never change), so a run cut short by the API rate limit resumes where it stopped.
//
// Node built-ins plus `gh api` only; see docs/40-operate/operations/ci-budget.md for what each number means.

import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { aggregate, pullRequestsToClassify } from './aggregate.mjs';
import { checkBudget, parseBudget } from './budget.mjs';
import { fetchJobs, fetchPullFiles, ghApi, listPulls, listRuns } from './github.mjs';
import { renderCheck, renderMarkdown } from './render.mjs';

const USAGE =
  'usage: node scripts/ci/metrics/report.mjs --days <n> [--repo owner/name] [--json|--markdown] ' +
  '[--check --budget docs/40-operate/operations/ci-budget.md] [--to <ISO time>] [--cache-dir <dir>]';

/**
 * @param {readonly string[]} argv
 */
export function parseCli(argv) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      days: { type: 'string' },
      repo: { type: 'string' },
      json: { type: 'boolean', default: false },
      markdown: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      budget: { type: 'string' },
      to: { type: 'string' },
      'cache-dir': { type: 'string' },
    },
    strict: true,
  });
  const days = Number(values.days);
  if (!Number.isFinite(days) || days <= 0 || days > 90)
    throw new Error(`--days must be a number in (0, 90]\n${USAGE}`);
  if (values.json && values.markdown)
    throw new Error(`--json and --markdown are exclusive\n${USAGE}`);
  if (values.check && !values.budget) throw new Error(`--check needs --budget <file>\n${USAGE}`);
  if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/u.test(values.repo)) {
    throw new Error(`--repo must be owner/name\n${USAGE}`);
  }
  const to = values.to === undefined ? new Date() : new Date(values.to);
  if (Number.isNaN(to.getTime())) throw new Error(`--to must be an ISO time\n${USAGE}`);
  return {
    days,
    repo: values.repo,
    format: values.json ? 'json' : 'markdown',
    check: values.check,
    budget: values.budget,
    to,
    cacheDir: values['cache-dir'],
  };
}

function defaultRepo() {
  if (process.env['GITHUB_REPOSITORY']) return process.env['GITHUB_REPOSITORY'];
  return execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    encoding: 'utf8',
  }).trim();
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const budget = options.budget ? parseBudget(readFileSync(options.budget, 'utf8')) : undefined;
  const repo = options.repo ?? defaultRepo();
  const from = new Date(options.to.getTime() - options.days * 86_400_000);
  const runs = await listRuns(ghApi, repo, from, options.to);
  const pulls = await listPulls(ghApi, repo, from);
  const jobsByRun = await fetchJobs(ghApi, repo, runs, options.cacheDir);
  const pullFiles = await fetchPullFiles(
    ghApi,
    repo,
    pullRequestsToClassify(runs, pulls),
    options.cacheDir,
  );
  const report = aggregate({ repo, from, to: options.to, runs, jobsByRun, pulls, pullFiles });

  if (options.check && budget) {
    const result = checkBudget(report, budget);
    process.stdout.write(
      options.format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : renderCheck(result),
    );
    process.exitCode = result.offending.length > 0 ? 1 : 0;
    return;
  }
  process.stdout.write(
    options.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
