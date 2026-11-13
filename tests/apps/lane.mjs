#!/usr/bin/env node
/* global setTimeout, console */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { packPackages } from '../app-kit/run.mjs';
import { positiveIntegerVariable } from '../generated-project/run.mjs';
import { spawnPackageServer } from './package-server.mjs';
import { parseLaneArgs } from './lane-results.mjs';
import { dockerAnswers, laneRegistry, verifySelfHostedApps } from './lane-self-host.mjs';
import { registeredApps, runApp } from './lane-app.mjs';
import { reportLaneResults } from './lane-report.mjs';

export {
  TEST_RESULTS_REPORTER,
  LANE_STEPS,
  STEP_CELLS,
  STEP_NEEDS,
  LANE_SCENARIOS,
  LANE_CELLS,
  PLATFORM_URL,
  appUrl,
  appSchema,
  JOURNEY_LOCALES,
} from './lane-config.mjs';

export {
  parseLaneArgs,
  blockedReason,
  cellVerdicts,
  claimedVerdict,
  laneFindings,
  journeyResults,
  journeysOutcome,
  testResults,
  agentOnDataOutcome,
  renderLaneSummary,
  renderScenarioSummary,
} from './lane-results.mjs';

export { attemptAsync, withTarballDependencies } from './lane-commands.mjs';

export { withThemeLocale, journeyEnv } from './lane-journeys.mjs';

export {
  withProductionApps,
  standInImage,
  composeAppsProblem,
  helmAppsProblem,
  renderedPlan,
} from './lane-self-host.mjs';

async function main() {
  const benchmarks = await registeredApps();
  const { apps, skip } = parseLaneArgs(
    process.argv.slice(2),
    benchmarks.map((benchmark) => benchmark.id),
  );
  const budget = positiveIntegerVariable('APPS_LANE_TIMEOUT_MS', 80 * 60_000);
  const guard = setTimeout(() => {
    console.error(`apps lane: the run did not finish within ${String(budget)} ms`);
    process.exit(1);
  }, budget);
  guard.unref();
  const keep = process.env['APPS_WORK_DIR'] !== undefined;
  const work = path.resolve(
    process.env['APPS_WORK_DIR'] ?? mkdtempSync(path.join(tmpdir(), 'apps-lane-')),
  );
  mkdirSync(work, { recursive: true });
  const home = path.join(work, 'home');
  mkdirSync(home, { recursive: true });
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    PATH: process.env['PATH'],
    HOME: home,
    LANG: process.env['LANG'] ?? 'C.UTF-8',
    TMPDIR: process.env['TMPDIR'],
    NO_COLOR: '1',
    // Next.js reports nothing home from a lane run.
    NEXT_TELEMETRY_DISABLED: '1',
    npm_config_cache:
      process.env['npm_config_cache'] ?? path.join(process.env['HOME'] ?? home, '.npm'),
  };
  console.log(`== packing the @indx-workspace packages into ${work}/packs`);
  const tarballs = packPackages(path.join(work, 'packs'));
  const docker = !skip.has('self-host') && dockerAnswers();
  const registry = laneRegistry();
  // The registry the image builds install from runs only when there is an image to build.
  const packages = docker ? await spawnPackageServer(tarballs, work) : undefined;
  const taken = new Set();
  const results = [];
  try {
    for (const id of apps) {
      const benchmark = benchmarks.find((candidate) => candidate.id === id);
      results.push(
        await runApp({ benchmark, skip, work, tarballs, env, taken, registry, packages }),
      );
    }
    await verifySelfHostedApps({ results, env, work, registry });
  } finally {
    registry.stop();
    packages?.close();
  }
  await reportLaneResults({ results, apps, skip, work, tarballs, env, keep });
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
