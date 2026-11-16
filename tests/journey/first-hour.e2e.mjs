/* global process, performance, setTimeout, console */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { quickstartCommands } from './harness.mjs';
import { runShell, killGroup, startDev } from './first-hour-process.mjs';
import { ROWS, row, seconds } from './first-hour-state.mjs';
import { addCodeTool, addSkill, addEvaluation, askFirstAnswer } from './first-hour-steps.mjs';

/** @param {string} name */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set: start this test with node tests/journey/run.mjs --first-hour`,
    );
  }
  return value;
}

const WORK_DIR = required('JOURNEY_FIRST_HOUR_DIR');

const OUT = required('JOURNEY_FIRST_HOUR_OUT');

const COMMANDS = quickstartCommands(readFileSync(required('JOURNEY_QUICKSTART'), 'utf8'));

async function runQuickstartCommands(journey) {
  for (const command of COMMANDS) {
    const from = performance.now();
    if (command.startsWith('cd ')) {
      journey.cwd = path.resolve(journey.cwd, command.slice(3).trim());
      continue;
    }
    if (command.startsWith('npm run dev')) {
      const started = await startDev(journey.cwd, 120_000);
      journey.dev = started.child;
      journey.devPid = started.pid;
      journey.devLog = started.log;
      row('T3').seconds = seconds(from);
      journey.verbatim += 1;
      continue;
    }
    const result = await runShell(command, journey.cwd);
    const id = command.startsWith('npm create')
      ? 'T1'
      : command.startsWith('npm install')
        ? 'T2'
        : undefined;
    expect(result.status, `${command}\n${result.output}`).toBe(0);
    if (id === 'T1') {
      // FH-02: the quickstart's `--yes` create succeeds with no terminal and writes the project.
      // (Without `--yes`, create prints the no-terminal notice; the quickstart does not run that.)
      const project = command.split(' ')[3] ?? '';
      expect(
        existsSync(path.join(journey.cwd, project, 'agent-workspace.yaml')),
        result.output,
      ).toBe(true);
    }
    if (id !== undefined) row(id).seconds = seconds(from);
    journey.verbatim += 1;
  }
}

/**
 * `aw dev`'s output since offset `since`, once it contains `text` or 30 s have passed.
 * @param {number} since @param {string} text
 */
async function devLogOnce(journey, since, text) {
  const deadline = performance.now() + 30_000;
  while (!(journey.devLog?.().slice(since) ?? '').includes(text) && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 500));
  return journey.devLog?.().slice(since) ?? '';
}

async function addConnector(journey) {
  // T7 (FH-08): a connector added to agent-workspace.yaml is applied by the running `aw dev`
  // (`applied: connector <name> (new)`), with no restart. The URL is never called: creating the
  // connector only stores it.
  const logAtT7 = journey.devLog?.().length ?? 0;
  const connectorStarted = performance.now();
  const yamlPath = path.join(journey.cwd, 'agent-workspace.yaml');
  writeFileSync(
    yamlPath,
    `${readFileSync(yamlPath, 'utf8')}
connectors:
  journey-mcp:
    url: http://127.0.0.1:9/mcp
`,
  );
  const afterT7 = await devLogOnce(journey, logAtT7, 'applied: connector journey-mcp (new)');
  expect(afterT7, 'aw dev did not apply the connector').toContain(
    'applied: connector journey-mcp (new)',
  );
  row('T7').seconds = seconds(connectorStarted);
  expect(
    journey.devLog?.().slice(logAtT7) ?? '',
    'the connector edit asked for a restart',
  ).not.toContain('restart aw dev');
}

async function assertNoRestartAfterYamlEdit(journey) {
  // No-restart check (FH-08): a yaml edit that changes no restart key (a comment) leaves the
  // same `aw dev` running and prints no restart line.
  const logBefore = journey.devLog?.().length ?? 0;
  const yamlFile = path.join(journey.cwd, 'agent-workspace.yaml');
  writeFileSync(
    yamlFile,
    `${readFileSync(yamlFile, 'utf8')}
# edited while aw dev runs
`,
  );
  // Wait for the sync that save triggers (its `synced:` line) before asserting what it did not
  // do; a fixed sleep would pass before a slow restart request was printed.
  const afterEdit = await devLogOnce(journey, logBefore, 'synced: ');
  expect(afterEdit, 'aw dev did not sync the yaml edit').toContain('synced: ');
  journey.sameDevAfterEdit =
    journey.dev !== undefined &&
    journey.dev.pid === journey.devPid &&
    journey.dev.exitCode === null;
  expect(journey.sameDevAfterEdit, 'aw dev stopped after a yaml edit').toBe(true);
  expect(afterEdit, 'a yaml edit asked for a restart').not.toContain('restart aw dev');
}

function saveFirstHourReport(journey) {
  const timed = ROWS.filter((candidate) => candidate.seconds !== undefined);
  for (const candidate of timed)
    console.log(`${candidate.id} ${candidate.name} ${String(candidate.seconds?.toFixed(1))} s`);
  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        steps: ROWS,
        docsCommands: {
          run: journey.verbatim,
          total: COMMANDS.filter((c) => !c.startsWith('cd ')).length,
        },
        firstAnswerAfterCreate: {
          seconds: journey.firstAnswerSeconds ?? null,
          targetSeconds: 60,
        },
        noRestart: {
          devPidAtT3: journey.devPid ?? null,
          sameAfterYamlEdit: journey.sameDevAfterEdit ?? null,
        },
      },
      null,
      2,
    )}\n`,
  );
}

test('the first hour, step by step', async () => {
  // run.mjs's exec cap (11 min) and the CI step's 25 min are sized from this.
  test.setTimeout(10 * 60_000);
  mkdirSync(WORK_DIR, { recursive: true });
  /** @type {{ cwd: string, verbatim: number, dev?: import('node:child_process').ChildProcess, devPid?: number, devLog?: () => string, firstAnswerSeconds?: number, sameDevAfterEdit?: boolean }} */
  const journey = { cwd: WORK_DIR, verbatim: 0 };

  try {
    await runQuickstartCommands(journey);
    const answer = await askFirstAnswer(journey);
    const { prompt, expected } = answer;

    await addCodeTool(journey.cwd);

    await addSkill(journey.cwd);

    await addConnector(journey);

    await addEvaluation(journey.cwd, prompt, expected);

    await assertNoRestartAfterYamlEdit(journey);
  } finally {
    if (journey.dev !== undefined) killGroup(journey.dev);
    saveFirstHourReport(journey);
  }
});
