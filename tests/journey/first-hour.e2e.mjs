/* global clearTimeout, console, performance, process, setTimeout */
/**
 * The first-hour stopwatch (FH-13, issue #700): the developer's first hour from `npm create` to
 * their own agent in their own app, one step per row T1..T9, timed in the clean container.
 *
 * T1-T3 run the shell block of `getting-started/quickstart.mdx` unchanged (`run.mjs` copies the page
 * next to this file): each command as written, with no TTY, and the one that never returns
 * (`npm run dev`) detached and waited on until `aw dev` prints its `try:` line. A step that waits
 * for a first-hour issue (FH-01 ... FH-12) is `pending`, naming it; it turns into a timed step when
 * that issue lands, by giving its row a `run`. Timings, and the `aw dev` process id, go to the JSON
 * file named by `JOURNEY_FIRST_HOUR_OUT`; `run.mjs --first-hour` reads it for the job summary.
 *
 * Targets are the B0 row of the developer-journey plan (issue #457, ADR-0101). They are reported, not
 * enforced, until the step's lane has landed.
 *
 * Named `.e2e.mjs` so the `tests` Vitest project never loads it (see widget.e2e.mjs).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { parseDevLine, quickstartCommands } from './harness.mjs';

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
/** The user's shell: no harness npm cache, so T1/T2 start cold as B1's do (run.mjs). */
const USER_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== 'npm_config_cache'),
);
/** The fake model's reply text (run.mjs, stubExpectation); the live run leaves it unset and expects the nonce. */
const STUB = process.env['JOURNEY_EXPECT_TEXT'];
const COMMANDS = quickstartCommands(readFileSync(required('JOURNEY_QUICKSTART'), 'utf8'));

/**
 * @typedef {{ id: string, name: string, targetSeconds?: number, pending?: string, seconds?: number }} Row
 * @type {Row[]}
 */
const ROWS = [
  { id: 'T1', name: 'create (no TTY)' },
  { id: 'T2', name: 'npm install (cold)', targetSeconds: 30 },
  { id: 'T3', name: 'aw dev ready', targetSeconds: 15 },
  { id: 'T4', name: 'first answer · aw chat -p' },
  { id: 'T5', name: 'add code tool → answer uses it', targetSeconds: 5 },
  { id: 'T6', name: 'add skill → synced' },
  { id: 'T7', name: 'add connector in yaml → applied' },
  { id: 'T8', name: 'aw eval add, then aw eval' },
  {
    id: 'T9',
    name: '<Chat/> in a Vite app answers',
    pending:
      'FH-12 (#699) landed; needs a Vite install, a browser page and an allowedOrigins entry in this harness',
  },
];
/** @param {string} id */
const row = (id) => {
  const found = ROWS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
};

/**
 * One command as the page writes it, in a shell with no TTY on any stream.
 *
 * @param {string} command @param {string} cwd
 */
function runShell(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      env: USER_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let stdout = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        output += String(chunk);
        if (stream === child.stdout) stdout += String(chunk);
        process.stdout.write(String(chunk));
      });
    }
    child.once('close', (status) => resolve({ status, output, stdout }));
  });
}

/** @param {import('node:child_process').ChildProcess} child */
function killGroup(child) {
  try {
    process.kill(-(child.pid ?? 0), 'SIGKILL');
  } catch {
    // already gone
  }
}

/**
 * `npm run dev`, detached from the step; resolves with its pid once it prints `try:`.
 *
 * @param {string} cwd @param {number} timeoutMs
 */
function startDev(cwd, timeoutMs) {
  // Detached: its own process group, so the kill reaches `aw dev` under npm, not npm alone.
  const child = spawn('sh', ['-c', 'exec npm run dev'], {
    cwd,
    env: USER_ENV,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  return new Promise((resolve, reject) => {
    let pending = '';
    const timer = setTimeout(() => {
      killGroup(child);
      reject(new Error(`aw dev printed no try: line in ${String(timeoutMs)} ms\n${log}`));
    }, timeoutMs);
    child.once('close', (status) => {
      clearTimeout(timer);
      reject(new Error(`aw dev exited ${String(status)} before it was ready\n${log}`));
    });
    /** @param {unknown} chunk */
    const read = (chunk) => {
      log += String(chunk);
      process.stdout.write(String(chunk));
      pending += String(chunk);
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      if (lines.some((line) => parseDevLine(line)?.kind === 'try')) {
        clearTimeout(timer);
        resolve({ child, pid: child.pid, log: () => log });
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
  });
}

test('the first hour, step by step', async () => {
  // run.mjs's exec cap (11 min) and the CI step's 25 min are sized from this.
  test.setTimeout(10 * 60_000);
  mkdirSync(WORK_DIR, { recursive: true });
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let dev;
  /** @type {number | undefined} */
  let devPid;
  /** @type {(() => string) | undefined} */
  let devLog;
  /** @type {boolean | undefined} */
  let sameDevAfterEdit;
  let cwd = WORK_DIR;
  let verbatim = 0;
  /** @type {number | undefined} */
  let firstAnswerSeconds;
  const seconds = (/** @type {number} */ from) => (performance.now() - from) / 1000;
  /**
   * `aw dev`'s output since offset `since`, once it contains `text` or 30 s have passed.
   * @param {number} since @param {string} text
   */
  const devLogOnce = async (since, text) => {
    const deadline = performance.now() + 30_000;
    while (!(devLog?.().slice(since) ?? '').includes(text) && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 500));
    return devLog?.().slice(since) ?? '';
  };
  /** @param {string} file @param {string} contents */
  const writeProjectFile = (file, contents) => {
    const target = path.join(cwd, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };

  try {
    for (const command of COMMANDS) {
      const from = performance.now();
      if (command.startsWith('cd ')) {
        cwd = path.resolve(cwd, command.slice(3).trim());
        continue;
      }
      if (command.startsWith('npm run dev')) {
        const started = await startDev(cwd, 120_000);
        dev = started.child;
        devPid = started.pid;
        devLog = started.log;
        row('T3').seconds = seconds(from);
        verbatim += 1;
        continue;
      }
      const result = await runShell(command, cwd);
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
        expect(existsSync(path.join(cwd, project, 'agent-workspace.yaml')), result.output).toBe(
          true,
        );
      }
      if (id !== undefined) row(id).seconds = seconds(from);
      verbatim += 1;
    }
    // T4 (FH-10): the first answer from the terminal; the nonce lets the fake model name it.
    const nonce = 'e2e-nonce-firsthour';
    const prompt = `Reply with exactly: ${nonce}`;
    const expected = STUB ?? nonce;
    let from = performance.now();
    const asked = await runShell(`npx aw chat -p '${prompt}' --json`, cwd);
    expect(asked.status, asked.output).toBe(0);
    expect(asked.stdout).toContain('{');
    expect(JSON.parse(asked.stdout.slice(asked.stdout.indexOf('{'))).status).toBe('completed');
    row('T4').seconds = seconds(from);
    const create = ['T1', 'T2', 'T3', 'T4'].map((id) => row(id).seconds);
    if (!create.includes(undefined)) {
      firstAnswerSeconds = create.reduce((sum, each) => sum + (each ?? 0), 0);
      console.log(`first answer after create: ${firstAnswerSeconds.toFixed(1)} s (target 60 s)`);
    }
    // The answer text is the plain-text form; untimed, so the number above is the --json call's.
    const text = await runShell(`npx aw chat -p '${prompt}'`, cwd);
    expect(text.status, text.output).toBe(0);
    expect(text.output).toContain(expected);

    // T5 (FH-06): add a code tool and list it on the agent while `aw dev` runs; the next answer
    // carries what the tool returned. The fake model calls only a tool whose name ends in
    // `getOrderByOrderNumber` (fake-anthropic-tools.mjs), so a live run leaves the row untimed.
    if (STUB === undefined) {
      row('T5').pending = 'a live model does not call the fake tool by name';
    } else {
      const toolNonce = 'e2e-nonce-codetool';
      writeProjectFile(
        'tools/get-order-by-order-number.ts',
        `import { defineTool, z } from '@indx-workspace/sdk/define';

export default defineTool({
  name: 'getOrderByOrderNumber',
  description: 'Look up an order by its number',
  input: z.object({ orderNumber: z.string() }),
  run: './tools/get-order-by-order-number.run.ts',
});
`,
      );
      writeProjectFile(
        'tools/get-order-by-order-number.run.ts',
        `import type { ToolRun } from '@indx-workspace/sdk/define';
import type getOrder from './get-order-by-order-number.ts';

const run: ToolRun<typeof getOrder> = ({ orderNumber }) => ({ note: \`order-data-\${orderNumber}\` });
export default run;
`,
      );
      from = performance.now();
      writeProjectFile(
        'agents/assistant.ts',
        `import { defineAgent } from '@indx-workspace/sdk/define';
import getOrder from '../tools/get-order-by-order-number.ts';

export default defineAgent({
  name: 'assistant',
  instructions: 'Help people. Look orders up with your tool.',
  tools: [getOrder],
});
`,
      );
      // The save syncs a new version with no restart; until it lands the answer has no tool result.
      const deadline = performance.now() + 60_000;
      let answered = '';
      let status = 0;
      while (!answered.includes(`order-data-${toolNonce}`) && performance.now() < deadline) {
        const asked = await runShell(`npx aw chat -p 'Where is order ${toolNonce}?'`, cwd);
        answered = asked.output;
        status = asked.status;
        // A broken `aw chat` fails the row now; a missing tool result only waits for the sync.
        expect(status, answered).toBe(0);
        if (!answered.includes(`order-data-${toolNonce}`))
          await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      row('T5').seconds = seconds(from);
      expect(answered, `aw chat exited ${String(status)}`).toContain(`order-data-${toolNonce}`);
    }

    // T6 (FH-07): a skills/ folder saved while aw dev runs becomes a workspace skill, and
    // `aw check` accepts the folder.
    from = performance.now();
    writeProjectFile(
      'skills/journey-skill/SKILL.md',
      [
        '---',
        'name: journey-skill',
        'description: Added while aw dev runs.',
        '---',
        '',
        'Say hello.',
        '',
      ].join('\n'),
    );
    let skillStatus = 1;
    for (let attempt = 0; attempt < 30 && skillStatus !== 0; attempt += 1) {
      skillStatus = (await runShell('npx aw skills get journey-skill', cwd)).status ?? 1;
      if (skillStatus !== 0) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    expect(skillStatus, 'aw dev did not sync skills/journey-skill').toBe(0);
    row('T6').seconds = seconds(from);
    const checked = await runShell('npx aw check', cwd);
    expect(checked.output).toContain('skills/journey-skill: ok');

    // T7 (FH-08): a connector added to agent-workspace.yaml is applied by the running `aw dev`
    // (`applied: connector <name> (new)`), with no restart. The URL is never called: creating the
    // connector only stores it.
    const logAtT7 = devLog?.().length ?? 0;
    from = performance.now();
    const yamlPath = path.join(cwd, 'agent-workspace.yaml');
    writeFileSync(
      yamlPath,
      `${readFileSync(yamlPath, 'utf8')}
connectors:
  journey-mcp:
    url: http://127.0.0.1:9/mcp
`,
    );
    const afterT7 = await devLogOnce(logAtT7, 'applied: connector journey-mcp (new)');
    expect(afterT7, 'aw dev did not apply the connector').toContain(
      'applied: connector journey-mcp (new)',
    );
    row('T7').seconds = seconds(from);
    expect(devLog?.().slice(logAtT7) ?? '', 'the connector edit asked for a restart').not.toContain(
      'restart aw dev',
    );

    // T8 (FH-11): add a case from the command line; `aw eval` with no arguments runs them all.
    from = performance.now();
    const added = await runShell(
      `npx aw eval add '${prompt}' --expect-contains '${expected}'`,
      cwd,
    );
    expect(added.status, added.output).toBe(0);
    const evaluated = await runShell('npx aw eval --json', cwd);
    row('T8').seconds = seconds(from);
    expect(evaluated.stdout).toContain('[');
    /** @type {{ passed: number; total: number; results: { name: string; passed: boolean }[] }[]} */
    const evaluations = JSON.parse(evaluated.stdout.slice(evaluated.stdout.indexOf('[')));
    // The exit code is the verdict: 0 when every case passed, 1 when any failed. The starter cases
    // may fail against the fake model (feedback.e2e.mjs), so only the added case must pass.
    const allPassed = evaluations.every((each) => each.passed === each.total);
    expect(evaluated.status, evaluated.output).toBe(allPassed ? 0 : 1);
    const cases = evaluations.flatMap((each) => each.results);
    expect(cases.find((each) => each.name === prompt)?.passed, evaluated.output).toBe(true);

    // No-restart check (FH-08): a yaml edit that changes no restart key (a comment) leaves the
    // same `aw dev` running and prints no restart line.
    const logBefore = devLog?.().length ?? 0;
    const yamlFile = path.join(cwd, 'agent-workspace.yaml');
    writeFileSync(
      yamlFile,
      `${readFileSync(yamlFile, 'utf8')}
# edited while aw dev runs
`,
    );
    // Wait for the sync that save triggers (its `synced:` line) before asserting what it did not
    // do; a fixed sleep would pass before a slow restart request was printed.
    const afterEdit = await devLogOnce(logBefore, 'synced: ');
    expect(afterEdit, 'aw dev did not sync the yaml edit').toContain('synced: ');
    sameDevAfterEdit = dev !== undefined && dev.pid === devPid && dev.exitCode === null;
    expect(sameDevAfterEdit, 'aw dev stopped after a yaml edit').toBe(true);
    expect(afterEdit, 'a yaml edit asked for a restart').not.toContain('restart aw dev');
  } finally {
    if (dev !== undefined) killGroup(dev);
    const timed = ROWS.filter((candidate) => candidate.seconds !== undefined);
    for (const candidate of timed)
      console.log(`${candidate.id} ${candidate.name} ${String(candidate.seconds?.toFixed(1))} s`);
    writeFileSync(
      OUT,
      `${JSON.stringify(
        {
          steps: ROWS,
          docsCommands: {
            run: verbatim,
            total: COMMANDS.filter((c) => !c.startsWith('cd ')).length,
          },
          firstAnswerAfterCreate: { seconds: firstAnswerSeconds ?? null, targetSeconds: 60 },
          noRestart: { devPidAtT3: devPid ?? null, sameAfterYamlEdit: sameDevAfterEdit ?? null },
        },
        null,
        2,
      )}\n`,
    );
  }
});
