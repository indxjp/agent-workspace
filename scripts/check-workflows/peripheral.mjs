// Where the workflows beside ci.yml may run (ADR-0053, Amendment 2026-11-19e): the costly lanes that
// left the pull request stay off it, a path filter on a pull request covers every path its job
// decides on, and a red Isolation run on main still reaches the alarm.
import path from 'node:path';

import { WORKFLOWS_DIRECTORY, jobBlock } from './ci-text.mjs';

const ISOLATION = path.posix.join(WORKFLOWS_DIRECTORY, 'isolation.yml');
const JOURNEY_LIVE = path.posix.join(WORKFLOWS_DIRECTORY, 'journey-live.yml');
const NIGHTLY_ALARM = path.posix.join(WORKFLOWS_DIRECTORY, 'nightly-alarm.yml');

const OFF_PULL_REQUEST = "    if: github.event_name != 'pull_request'";
// The two kind lanes: about 20 Blacksmith minutes a run between them.
const ISOLATION_MAIN_ONLY_JOBS = ['kind', 'kind-deploy'];

/**
 * The isolation kind lanes run on main (push, schedule) and on a dispatch, never on a pull request.
 * @param {string[]} failures @param {string} source
 */
function checkIsolationKindLanes(failures, source) {
  for (const jobId of ISOLATION_MAIN_ONLY_JOBS) {
    const job = jobBlock(source, jobId);
    const ifLines = job?.match(/^ {4}if:.*$/gmu) ?? [];
    if (job === null || ifLines.length !== 1 || ifLines[0] !== OFF_PULL_REQUEST) {
      failures.push(
        `${ISOLATION}#${jobId}: the kind lane must run only${OFF_PULL_REQUEST.slice(3)}`,
      );
    }
  }
}

/**
 * The `- path` entries of `on.pull_request.paths`, or `null` when the trigger has no path filter.
 * @param {string} source
 */
export function pullRequestPaths(source) {
  const lines = source.split(/\r?\n/u);
  const header = lines.findIndex((line) => /^ {2}pull_request:\s*$/u.test(line));
  if (header < 0) return null;
  /** @type {string[] | null} */
  let paths = null;
  for (const line of lines.slice(header + 1)) {
    if (line.trim() !== '' && !line.startsWith('    ') && !/^ {2}#/u.test(line)) break;
    if (/^ {4}paths:\s*$/u.test(line)) {
      paths = [];
      continue;
    }
    const item = /^ {6}- (.+?)\s*$/u.exec(line)?.[1];
    if (paths !== null && item !== undefined) paths.push(item.replace(/^["']|["']$/gu, ''));
    else if (paths !== null && /^ {4}\S/u.test(line)) break;
  }
  return paths;
}

/**
 * The prefixes a scope step's `pattern='^(a|b\.c$|…)'` alternation names, unescaped.
 * @param {string} source
 */
export function scopePrefixes(source) {
  return Array.from(source.matchAll(/^\s+pattern='\^\(([^']*)\)'$/gmu)).flatMap((match) =>
    (match[1] ?? '')
      .split('|')
      .map((alternative) => alternative.replace(/\$$/u, '').replace(/\\(.)/gu, '$1')),
  );
}

/**
 * journey-live.yml's pull-request jobs decide from a scope pattern each; the workflow's path filter
 * must start it for every path either pattern names, or a change the job would test never runs it.
 * @param {string[]} failures @param {string} source
 */
function checkJourneyLivePaths(failures, source) {
  const paths = pullRequestPaths(source);
  if (paths === null) {
    failures.push(
      `${JOURNEY_LIVE}: on.pull_request must carry the paths its scope steps read, so an unrelated pull request starts no MS-A2 job`,
    );
    return;
  }
  const prefixes = new Set(paths.map((entry) => entry.replace(/\*\*$/u, '')));
  for (const prefix of scopePrefixes(source)) {
    if (!prefixes.has(prefix)) {
      failures.push(
        `${JOURNEY_LIVE}: on.pull_request.paths must list ${prefix.endsWith('/') ? `${prefix}**` : prefix}, which a scope step reads`,
      );
    }
  }
}

/**
 * The alarm must watch Isolation and act on its pushes to main, where its kind lanes now run.
 * @param {string[]} failures @param {string} source
 */
function checkAlarmWatchesIsolation(failures, source) {
  const watched = /^ {4}workflows: \[([^\]]*)\]$/mu
    .exec(source)?.[1]
    ?.split(',')
    .map((name) => name.trim());
  if (
    watched?.includes('Isolation') !== true ||
    !source.includes(
      "(github.event.workflow_run.name == 'Isolation' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main')",
    )
  ) {
    failures.push(
      `${NIGHTLY_ALARM}: must watch Isolation and act on its pushes to main, where the kind lanes run`,
    );
  }
}

/**
 * Every peripheral rule, in the gate's order. A workflow the tree lacks (the public export drops
 * some) is not checked.
 * @param {string[]} failures @param {ReadonlyMap<string, string>} workflows
 */
export function validatePeripheralWorkflows(failures, workflows) {
  const isolation = workflows.get(ISOLATION);
  if (isolation !== undefined) checkIsolationKindLanes(failures, isolation);
  const journeyLive = workflows.get(JOURNEY_LIVE);
  if (journeyLive !== undefined) checkJourneyLivePaths(failures, journeyLive);
  const alarm = workflows.get(NIGHTLY_ALARM);
  if (alarm !== undefined && isolation !== undefined) checkAlarmWatchesIsolation(failures, alarm);
}
