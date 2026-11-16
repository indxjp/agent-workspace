/* global performance, setTimeout, console */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { runShell } from './first-hour-process.mjs';
import { STUB, row, seconds } from './first-hour-state.mjs';

/** @param {string} cwd @param {string} file @param {string} contents */
function writeProjectFile(cwd, file, contents) {
  const target = path.join(cwd, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/** @param {string} cwd */
export async function addCodeTool(cwd) {
  // T5 (FH-06): add a code tool and list it on the agent while `aw dev` runs; the next answer
  // carries what the tool returned. The fake model calls only a tool whose name ends in
  // `getOrderByOrderNumber` (fake-anthropic-tools.mjs), so a live run leaves the row untimed.
  if (STUB === undefined) {
    row('T5').pending = 'a live model does not call the fake tool by name';
  } else {
    const toolNonce = 'e2e-nonce-codetool';
    writeCodeToolFiles(cwd);
    const from = performance.now();
    writeProjectFile(
      cwd,
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
}

/** @param {string} cwd */
export async function addSkill(cwd) {
  // T6 (FH-07): a skills/ folder saved while aw dev runs becomes a workspace skill, and
  // `aw check` accepts the folder.
  const from = performance.now();
  writeProjectFile(
    cwd,
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
}

/** @param {string} cwd @param {string} prompt @param {string} expected */
export async function addEvaluation(cwd, prompt, expected) {
  // T8 (FH-11): add a case from the command line; `aw eval` with no arguments runs them all.
  const from = performance.now();
  const added = await runShell(`npx aw eval add '${prompt}' --expect-contains '${expected}'`, cwd);
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
}

export async function askFirstAnswer(journey) {
  const { cwd } = journey;
  // T4 (FH-10): the first answer from the terminal; the nonce lets the fake model name it.
  const nonce = 'e2e-nonce-firsthour';
  const prompt = `Reply with exactly: ${nonce}`;
  const expected = STUB ?? nonce;
  const from = performance.now();
  const asked = await runShell(`npx aw chat -p '${prompt}' --json`, cwd);
  expect(asked.status, asked.output).toBe(0);
  expect(asked.stdout).toContain('{');
  expect(JSON.parse(asked.stdout.slice(asked.stdout.indexOf('{'))).status).toBe('completed');
  row('T4').seconds = seconds(from);
  const create = ['T1', 'T2', 'T3', 'T4'].map((id) => row(id).seconds);
  if (!create.includes(undefined)) {
    journey.firstAnswerSeconds = create.reduce((sum, each) => sum + (each ?? 0), 0);
    console.log(
      `first answer after create: ${journey.firstAnswerSeconds.toFixed(1)} s (target 60 s)`,
    );
  }
  // The answer text is the plain-text form; untimed, so the number above is the --json call's.
  const text = await runShell(`npx aw chat -p '${prompt}'`, cwd);
  expect(text.status, text.output).toBe(0);
  expect(text.output).toContain(expected);

  return { prompt, expected };
}

function writeCodeToolFiles(cwd) {
  writeProjectFile(
    cwd,
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
    cwd,
    'tools/get-order-by-order-number.run.ts',
    `import type { ToolRun } from '@indx-workspace/sdk/define';
import type getOrder from './get-order-by-order-number.ts';

const run: ToolRun<typeof getOrder> = ({ orderNumber }) => ({ note: \`order-data-\${orderNumber}\` });
export default run;
`,
  );
}
