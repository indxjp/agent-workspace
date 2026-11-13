#!/usr/bin/env node
/* global setTimeout, console */

import { portalSignsIn, wikiServes } from './run-app-sessions.mjs';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { positiveIntegerVariable } from '../generated-project/run.mjs';
import {
  SCRIPTED_MODEL,
  closeTicketScript,
  withTarballs,
  packPackages,
  npmInstall,
  portalCase,
  TEMPLATE_CASES,
  templateCase,
} from './run-projects.mjs';
import { removeWorkDirectory, casesOf } from './run-process.mjs';
import { runDeskCase } from './run-desk-case.mjs';

export {
  APP_NAME,
  PROJECT_NAME,
  SCRIPTED_MODEL,
  TYPE_CHECK_PACKAGES,
  PORTAL_PROJECT,
  APP_CI_WORKFLOW,
  ciRunSteps,
  withAgentWrite,
  withModel,
  closeTicketScript,
  withTarballs,
  packPackages,
  TEMPLATE_CASES,
  readmeCommands,
} from './run-projects.mjs';

export { removeWorkDirectory, casesOf, freePort, startDev } from './run-process.mjs';

export {
  SIGN_IN_PROOF_ROUTE,
  signInProofRoute,
  pkcePair,
  devIssuerCode,
  signIn,
  storeAppIdentity,
  signInConfigured,
} from './run-identity.mjs';

async function main() {
  const cases = casesOf(process.argv.slice(2));
  const budget = positiveIntegerVariable('APP_KIT_TIMEOUT_MS', 40 * 60_000);
  const guard = setTimeout(() => {
    console.error(`app-kit E2E: the run did not finish within ${String(budget)} ms`);
    process.exit(1);
  }, budget);
  guard.unref();
  const keep = process.env['APP_KIT_WORK_DIR'] !== undefined;
  const work = path.resolve(
    process.env['APP_KIT_WORK_DIR'] ?? mkdtempSync(path.join(tmpdir(), 'app-kit-e2e-')),
  );
  const home = path.join(work, 'home');
  const scripts = path.join(work, 'scripted-models');
  mkdirSync(home, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  const scriptFile = path.join(scripts, `${SCRIPTED_MODEL}.json`);
  writeFileSync(scriptFile, JSON.stringify(closeTicketScript(undefined)));
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    PATH: process.env['PATH'],
    HOME: home,
    LANG: process.env['LANG'] ?? 'C.UTF-8',
    TMPDIR: process.env['TMPDIR'],
    NO_COLOR: '1',
    npm_config_cache:
      process.env['npm_config_cache'] ?? path.join(process.env['HOME'] ?? home, '.npm'),
  };

  console.log(`== packing the @indx-workspace packages into ${work}/packs`);
  const tarballs = packPackages(path.join(work, 'packs'));
  const consumer = path.join(work, 'consumer');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    path.join(consumer, 'package.json'),
    `${JSON.stringify(withTarballs({ name: 'consumer', private: true, type: 'module', dependencies: Object.fromEntries(Object.keys(tarballs).map((name) => [name, '*'])) }, tarballs), null, 2)}\n`,
  );
  npmInstall(consumer, env);

  const create = path.join(consumer, 'node_modules/@indx-workspace/create/dist/index.js');
  if (cases.includes('portal')) {
    await portalSignsIn(portalCase({ work, create, tarballs, env }), env, scripts);
    console.log('== portal case passed');
  }
  for (const directory of /** @type {(keyof typeof TEMPLATE_CASES)[]} */ (
    Object.keys(TEMPLATE_CASES)
  )) {
    if (!cases.includes(directory)) continue;
    const project = templateCase({ work, create, tarballs, env }, directory);
    if (directory === 'wiki') await wikiServes(project, env, scripts);
  }
  if (!cases.includes('desk')) {
    console.log('== app-kit E2E passed');
    if (!keep) removeWorkDirectory(work);
    return;
  }

  await runDeskCase({ work, create, tarballs, env, scripts, scriptFile, keep });
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
