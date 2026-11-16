/**
 * @typedef {import('./run.d.mts').Machine} Machine
 * @typedef {import('./run.d.mts').PagePlan} PagePlan
 * @typedef {import('./run.d.mts').Row} Row
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { JourneyFailure } from '../journey/harness.mjs';
import { say, scrub } from '../journey/run.mjs';
import { DEV_COMMAND, NEEDS_KEY, FIRST_HOUR_OWNS } from './run-config.mjs';
import { whereOf } from './run-plans.mjs';
import { runCommand } from './run-command.mjs';
export { shell, containerMachine } from './run-command.mjs';

/**
 * The rows of a page whose every run block is `owned` (the commands journey-e2e's first-hour leg
 * runs), or null when the page has a block of its own to run. An empty `owned` owns nothing.
 *
 * @param {PagePlan} plan @param {readonly string[]} owned
 * @returns {Row[] | null}
 */
export function ownedRows(plan, owned) {
  const key = owned.join('\n');
  if (key === '' || !plan.blocks.every((block) => block.commands.join('\n') === key)) return null;
  return plan.blocks.map((block) => ({
    where: whereOf(block.claim),
    state: 'run',
    what: block.commands.join(' ; '),
    result: FIRST_HOUR_OWNS,
  }));
}

/** @param {Machine} machine @param {{cwd: string}} state @param {readonly string[]} commands @param {boolean} modelMissing */
async function runBlockCommands(machine, state, commands, modelMissing) {
  let detail = '';
  for (const command of commands) {
    if (modelMissing && command === DEV_COMMAND) {
      return { failed: false, withoutModel: true, detail };
    }
    let outcome;
    try {
      outcome = await runCommand(machine, state, command);
    } catch (error) {
      outcome = {
        ok: false,
        output: `$ ${command}\n${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
    detail += outcome.output;
    if (!outcome.ok) {
      return { failed: true, withoutModel: false, detail };
    }
  }
  return { failed: false, withoutModel: false, detail };
}

/** @param {import('./run.d.mts').Block} block @param {{shell: string, failed: boolean, withoutModel: boolean}} state */
function blockResultWithoutRunning(block, state) {
  if (block.sameAsLine !== undefined) return `pass (same commands as :${String(block.sameAsLine)})`;
  if (block.claim.shell !== undefined && block.claim.shell !== state.shell)
    return `n/a (${block.claim.shell} only)`;
  if (state.failed) return 'skipped: an earlier block of the page failed';
  if (state.withoutModel) return NEEDS_KEY;
  return undefined;
}

function blockOutcome(outcome) {
  if (outcome.failed) return { result: 'FAIL: a command did not exit 0', label: 'FAIL' };
  if (outcome.withoutModel) return { result: NEEDS_KEY, label: 'skipped' };
  return { result: 'pass', label: 'pass' };
}

async function executePageBlocks(machine, plan, { progress, dir, modelMissing }) {
  for (const block of plan.blocks) {
    const where = whereOf(block.claim);
    const what = block.commands.join(' ; ');
    const skipped = blockResultWithoutRunning(block, {
      shell: machine.shell,
      failed: progress.failed,
      withoutModel: progress.withoutModel,
    });
    if (skipped !== undefined) {
      progress.rows.push({ where, state: 'run', what, result: skipped });
      continue;
    }
    if (block.fresh === true) {
      progress.cwd = machine.resolve(dir, String(block.claim.line));
      await machine.project(progress.cwd);
    }
    const started = performance.now();
    const outcome = await runBlockCommands(machine, progress, block.commands, modelMissing);
    progress.failed = outcome.failed;
    progress.withoutModel = outcome.withoutModel;
    const { detail } = outcome;
    const verdict = blockOutcome(outcome);
    progress.log += `== ${where}\n${scrub(detail)}\n`;
    progress.rows.push({
      where,
      state: 'run',
      what,
      result: verdict.result,
      seconds: (performance.now() - started) / 1000,
      detail: progress.failed ? detail : undefined,
    });
    say(`${where} ${verdict.label}`);
  }
}

/**
 * @param {Machine} machine @param {PagePlan} plan
 * @param {Map<string, Row[]>} done the rows of the pages already run, by page
 * @param {boolean} modelMissing whether the live model has no key, so `npm run dev` cannot run
 * @returns {Promise<Row[]>}
 */
export async function runPage(machine, plan, done, modelMissing) {
  const earlier = plan.sameAsPage === undefined ? undefined : done.get(plan.sameAsPage);
  if (plan.sameAsPage !== undefined && earlier !== undefined) {
    return plan.blocks.map((block) => ({
      where: whereOf(block.claim),
      state: 'run',
      what: block.commands.join(' ; '),
      result: earlier.some((row) => row.result.startsWith('FAIL'))
        ? `FAIL: same commands as ${plan.sameAsPage}, which failed`
        : earlier.some((row) => row.result.startsWith('skipped'))
          ? `skipped: same commands as ${plan.sameAsPage}, which were`
          : `pass (same commands as ${plan.sameAsPage})`,
    }));
  }
  // An empty slug resolves to the claims root itself, which the cleanup below would remove.
  if (plan.slug === '') throw new JourneyFailure(`${plan.page} has no slug to name its directory`);
  const dir = machine.resolve(machine.claims, plan.slug);
  await machine.project(dir);
  const progress = { cwd: dir, log: '', failed: false, withoutModel: false, rows: [] };
  try {
    await executePageBlocks(machine, plan, { progress, dir, modelMissing });
  } finally {
    // Each page's project holds a full node_modules and embedded PostgreSQL; nothing reads it once
    // the log is written, and kept for every page it fills the runner's disk (#1098).
    try {
      writeFileSync(path.join(machine.logs, `${plan.slug}.log`), progress.log);
    } finally {
      await machine.remove(dir).catch((/** @type {unknown} */ error) => {
        say(
          `could not remove ${dir}: ${scrub(error instanceof Error ? error.message : String(error))}`,
        );
      });
    }
  }
  return progress.rows;
}
