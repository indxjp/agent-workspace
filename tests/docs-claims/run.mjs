#!/usr/bin/env node
/**
 * @typedef {import('./run.d.mts').Row} Row
 */
/* global console */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { workDirectoryOf } from '../journey/harness.mjs';
import { SECRETS, scrub } from '../journey/run.mjs';
import { extractRepositoryClaims } from './extract.mjs';
import { ROOT } from './run-config.mjs';
import { parseArguments, staticRows } from './run-plans.mjs';
import { exitCodeOf, save, report } from './run-report.mjs';
import { machineRows } from './run-machine.mjs';
import { claimRunNotes } from './run-notes.mjs';

export {
  parseArguments,
  runPlans,
  compileSources,
  tscDiagnostics,
  staticRows,
} from './run-plans.mjs';

export { exitCodeOf, summaryMarkdown, save } from './run-report.mjs';

export { ownedRows, runPage } from './run-execution.mjs';

async function main() {
  const options = parseArguments(process.argv.slice(2), process.env);
  if (options.apiKey !== '') SECRETS.add(options.apiKey);
  delete process.env['ANTHROPIC_API_KEY'];
  const work = path.resolve(
    workDirectoryOf(process.env['DOCS_CLAIMS_WORK_DIR']) ??
      mkdtempSync(path.join(tmpdir(), 'docs-claims-')),
  );
  const logs = path.join(work, 'logs');
  mkdirSync(logs, { recursive: true });
  const { SETUP_QUESTIONS } = await import('@indx-workspace/contracts/setup');
  const claims = extractRepositoryClaims(ROOT);
  const rows = staticRows(
    claims,
    SETUP_QUESTIONS.map((question) => question.flag),
  );
  const notes = claimRunNotes(options);
  /** @type {readonly Row[]} */
  let seen = [];
  let written = true;
  try {
    if (options.staticOnly) {
      notes.push('Static only (`--static`): no run or compile claim was executed.');
    } else {
      // Rewritten after every page, so a step timeout keeps the rows already produced.
      const partial = (/** @type {readonly Row[]} */ done) => {
        seen = done;
        save([...rows, ...done], notes, work);
      };
      rows.push(...(await machineRows({ options, claims, work, logs, partial })));
    }
  } catch (error) {
    rows.push(...seen, {
      where: 'tests/docs-claims/run.mjs',
      state: 'run',
      what: 'the clean machine',
      result: 'FAIL: the run stopped before every claim ran',
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      report(rows, notes, work);
    } catch (error) {
      console.error(
        `docs claims: ${scrub(error instanceof Error ? error.message : String(error))}; the results are incomplete`,
      );
      written = false;
    }
  }
  process.exitCode = written ? exitCodeOf(rows) : 1;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(scrub(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
