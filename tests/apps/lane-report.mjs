/* global console */

import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runBlueprintScenario } from './blueprint.mjs';
import {
  cellVerdicts,
  laneFindings,
  renderLaneSummary,
  renderScenarioSummary,
} from './lane-results.mjs';
import { installStep, appTests } from './lane-commands.mjs';

/**
 * The `blueprint` scenario (`blueprint.mjs`): a `gap` when `--skip` names it or `minimal` is not
 * among the apps, else its outcome.
 *
 * @param {{ apps: readonly string[], skip: ReadonlySet<string>, work: string,
 *   tarballs: Record<string, string>, env: NodeJS.ProcessEnv }} options
 * @returns {Promise<{ status: 'ok' | 'failed' | 'gap', reason: string }>}
 */
async function blueprintScenario({ apps, skip, work, tarballs, env }) {
  if (skip.has('blueprint')) return { status: 'gap', reason: 'skipped by --skip' };
  if (!apps.includes('minimal')) return { status: 'gap', reason: 'minimal is not among the apps' };
  console.log('== the blueprint scenario: a fixture app blueprint installed into minimal');
  const outcome = await runBlueprintScenario({
    work,
    env,
    install: (copy) => installStep('minimal', copy, tarballs, env),
    nodeTests: (copy) => appTests(copy, work, env),
  });
  console.log(`== blueprint: ${outcome.status} (${outcome.reason.split('\n')[0]})`);
  return outcome;
}

export async function reportLaneResults({ results, apps, skip, work, tarballs, env, keep }) {
  const blueprint = await blueprintScenario({ apps, skip, work, tarballs, env });
  const scored = results.map((result) => ({ ...result, verdicts: cellVerdicts(result.outcomes) }));
  const findings = scored.map((result) =>
    laneFindings(result.benchmark, result.verdicts, result.unexcused),
  );
  const failures = findings.flatMap((finding) => finding.failures);
  if (blueprint.status === 'failed') failures.push(`blueprint scenario: ${blueprint.reason}`);
  for (const notice of findings.flatMap((finding) => finding.notices))
    console.log(`notice: ${notice}`);
  const summary = `${renderLaneSummary(scored)}${renderScenarioSummary('blueprint', blueprint)}`;
  console.log(summary);
  if (process.env['GITHUB_STEP_SUMMARY'] !== undefined)
    appendFileSync(process.env['GITHUB_STEP_SUMMARY'], summary);
  writeFileSync(
    path.join(work, 'lane-report.json'),
    `${JSON.stringify(
      scored.map(({ benchmark, outcomes, verdicts }) => ({
        id: benchmark.id,
        steps: Object.fromEntries(outcomes),
        verdicts,
      })),
      null,
      2,
    )}\n`,
  );
  if (failures.length > 0) {
    console.error(
      `apps lane failed; the work directory is kept at ${work}\n${failures.map((failure) => `  ${failure}`).join('\n')}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log('== apps lane passed');
  if (!keep) rmSync(work, { recursive: true, force: true });
}
