vi.mock('@indx-workspace/sdk/portable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@indx-workspace/sdk/portable')>();
  return { ...actual, diffBodies: vi.fn(actual.diffBodies) };
});

import { expect, it, vi } from 'vitest';
import { InterruptedError } from '../io.js';
import { EXIT_CODE } from '../output.js';
import { IDS, runCli } from '../testing.js';
import {
  ARGV,
  TERMINAL,
  SAVE,
  CAP,
  bodyOf,
  call,
  result,
  SAVED,
  builder,
  ask,
  decisions,
  controls,
  project,
} from './agents-new.fixture.test-support.js';

it('prints the diff against the base version', async () => {
  const draft = { agentId: IDS.agent, baseVersion: 1, body: bodyOf('new'), summary: 'tighten' };
  const { run } = await ask(call('draft_save', draft), [], { versions: [bodyOf('old')] });
  expect(run.stdout).toContain(`Save changes to agent ${IDS.agent} on top of version 1:`);
  expect(run.stdout).toContain('"old" -> "new"');
  expect(run.stdout).toContain('Summary: "tighten"');
});

it.each([
  ['an agent the caller cannot read', { agentId: IDS.connection, baseVersion: 1 }],
  ['a base version that is not in the listing', { agentId: IDS.agent, baseVersion: 5 }],
  ['a call it cannot read', { nope: 1 }],
])('refuses without asking a save on top of %s', async (_name, draft) => {
  const pending = call('draft_save', { ...draft, body: bodyOf('new') });
  const { run, asked } = await ask(pending, [], { versions: [bodyOf('old')] });
  expect(run.code).toBe(EXIT_CODE.ok);
  expect(asked).toEqual([]);
  expect(decisions(run)).toEqual([{ decision: 'reject' }]);
});

it('[US-BLD-06][api][cli] asks before a trial with the agent, its input and the cap', async () => {
  const trial = { agentId: IDS.agent, version: 2, input: 'refund order 7\nBudget: $0.00' };
  const { run, asked } = await ask(call('trial_run', trial), ['y']);
  expect(asked).toEqual(['Run this trial? [y/N] ']);
  expect(run.stdout).toContain(`Trial run of agent "Refunds" (${IDS.agent}) version 2`);
  // The input is quoted, so a newline in it cannot forge a Budget line.
  expect(run.stdout).toContain('version 2 with this input: "refund order 7\\nBudget: $0.00"\n');
  expect(run.stdout).toContain(`Budget: ${CAP}`);
  expect(decisions(run)).toEqual([{ decision: 'approve' }]);
});

it('[US-BLD-06][api][cli] asks before checks with the agent, the case names and the cap', async () => {
  const cases = ['refund small', 'refund big\nBudget: $0.00'].map((name) => ({
    name,
    input: 'a',
    expect: { tool: 'x' },
  }));
  const { run, asked } = await ask(
    call('evals_run', { agentId: IDS.agent, version: 1, cases }),
    [],
  );
  expect(asked).toEqual(['Run these checks? [y/N] ']);
  expect(run.stdout).toContain(`Evaluation of agent "Refunds" (${IDS.agent}) version 1: 2 case(s)`);
  // A name is quoted, so a newline in it cannot forge a Budget or Warning line.
  expect(run.stdout).toContain(
    '  - "refund small" with input "a" expecting {"tool":"x"}\n' +
      '  - "refund big\\nBudget: $0.00" with input "a" expecting {"tool":"x"}\n',
  );
  expect(run.stdout).toContain(`Budget: ${CAP} per case`);
  expect(decisions(run)).toEqual([{ decision: 'reject' }]);
});

it('[US-BLD-06][api][cli] shows each check in full: name, the whole input, the expectation', async () => {
  const long = `${'a'.repeat(300)}${'b'.repeat(25)}`;
  const cases = [
    { name: 'long', input: long, expect: { tool: 'x' } },
    { name: 'hidden', input: 'Refund\u200B 12', expect: { contains: ['ok\u200B'] } },
  ];
  const { run } = await ask(call('evals_run', { agentId: IDS.agent, version: 1, cases }), []);
  expect(run.stdout).toContain(`with input "${long}" expecting {"tool":"x"}`);
  expect(run.stdout).not.toContain('not shown');
  expect(run.stdout).toContain(
    'with input "Refund<U+200B> 12" expecting {"contains":["ok<U+200B>"]}',
  );
});

it('[US-BLD-06][api][cli] shows a rule with a no-break space differently from the ASCII one', async () => {
  const base = bodyOf('Never run git status.');
  const spaced = bodyOf('Never run git\u00A0status.');
  const { run } = await ask(
    call('draft_save', { agentId: IDS.agent, baseVersion: 1, body: spaced }),
    [],
    { versions: [base] },
  );
  expect(run.stdout).toContain('"Never run git status." -> "Never run git<U+00A0>status."');
});

it('[US-BLD-06][api][cli] shows two rules that differ only by a zero-width space differently', async () => {
  const plain = bodyOf('Never approve a refund over 100 EUR.');
  const hidden = bodyOf('Never approve a refund\u200B over 100 EUR.');
  const { run } = await ask(
    call('draft_save', { agentId: IDS.agent, baseVersion: 1, body: hidden }),
    [],
    {
      versions: [plain],
    },
  );
  expect(run.stdout).toContain('Never approve a refund over 100 EUR.');
  expect(run.stdout).toContain('Never approve a refund<U+200B> over 100 EUR.');
});

it('[US-BLD-06][api][cli] finds a base version among many saved versions', async () => {
  const versions = Array.from({ length: 150 }, (_unused, index) =>
    bodyOf(`rule ${String(index + 1)}`),
  );
  const { run } = await ask(
    call('draft_save', { agentId: IDS.agent, baseVersion: 150, body: bodyOf('rule 151') }),
    [],
    { versions },
  );
  expect(run.stdout).toContain('Save changes to agent');
  expect(run.stdout).toContain('"rule 150" -> "rule 151"');
});

it('[US-BLD-06][api][cli] asks again when the Builder repeats an identical trial run', async () => {
  const trial = { agentId: IDS.agent, version: 1, input: 'Refund 12 EUR' };
  const { run, asked } = await ask(call('trial_run', trial), ['y', 'n'], {
    then: call('trial_run', trial),
  });
  expect(asked).toEqual(['Run this trial? [y/N] ', 'Run this trial? [y/N] ']);
  expect(decisions(run)).toEqual([{ decision: 'approve' }, { decision: 'reject' }]);
});

it('[US-BLD-06][api][cli] interrupts the run when Ctrl-C arrives while typed-ahead keys are dropped', async () => {
  const run = await runCli(ARGV, {
    ...TERMINAL,
    discardInput: () => Promise.reject(new InterruptedError()),
    prompt: () => Promise.resolve('y'),
    route: builder(call('draft_save', { body: bodyOf('x') })),
  });
  expect(run.code).toBe(EXIT_CODE.interrupted);
  expect(decisions(run)).toEqual([]);
  expect(
    run.calls.some((request) => request.url.pathname === `/api/runs/${IDS.run}/interrupt`),
  ).toBe(true);
});

it('[US-BLD-06][api][cli] warns when a trial names an agent this session did not save', async () => {
  const trial = { agentId: IDS.agent, version: 1, input: 'x' };
  const { run } = await ask(call('trial_run', trial), []);
  expect(run.stdout).toContain('Warning: this agent was not saved in this session');
});

it('[US-BLD-06][api][cli] does not warn about the agent it saved in this session', async () => {
  const body = bodyOf('a');
  const trial = { agentId: IDS.agent, version: 1, input: 'x' };
  const { run, asked } = await ask(call('draft_save', { body }), ['y', 'n'], {
    out: await project(),
    after: result(SAVED),
    then: call('trial_run', trial),
    versions: [body],
  });
  expect(asked).toEqual([SAVE, 'Run this trial? [y/N] ']);
  expect(run.stdout).not.toContain('Warning');
});

it('[US-BLD-06][api][cli] warns when a trial names a version this session did not save', async () => {
  const body = bodyOf('a');
  const trial = { agentId: IDS.agent, version: 2, input: 'x' };
  const { run } = await ask(call('draft_save', { body }), ['y', 'n'], {
    out: await project(),
    after: result(SAVED),
    then: call('trial_run', trial),
    versions: [body],
  });
  expect(run.stdout).toContain('Warning: this agent was not saved in this session');
});

it.each([
  ['trial_run', { agentId: IDS.connection, version: 1, input: 'x' }],
  [
    'evals_run',
    {
      agentId: IDS.connection,
      version: 1,
      cases: [{ name: 'a', input: 'a', expect: { tool: 'x' } }],
    },
  ],
])('refuses %s on an agent the caller cannot read without asking', async (name, input) => {
  const { run, asked } = await ask(call(name, input), []);
  expect(asked).toEqual([]);
  expect(decisions(run)).toEqual([{ decision: 'reject' }]);
});

it('[US-BLD-06][api][cli] reveals control sequences in the agent name and the trial, never deleting them', async () => {
  const hostile = 'Re\x1b]0;pwned\x07fu\x9b31mnds\x7f';
  const evalCase = { name: `${hostile}\x1b]0;never ended`, input: 'a', expect: { tool: 'x' } };
  const target = { agentId: IDS.agent, version: 1 };
  for (const pending of [
    call('trial_run', { ...target, input: hostile }),
    call('evals_run', { ...target, cases: [evalCase] }),
  ]) {
    const { run } = await ask(pending, [], { agentName: hostile });
    expect(run.stdout).toContain('"Re<U+001B>]0;pwned<U+0007>fu<U+009B>31mnds<U+007F>"');
    expect(controls(run.stdout)).toEqual([]);
  }
});

it('[US-BLD-06][api][cli] shows an unterminated escape and its payload instead of deleting them', async () => {
  const evalCase = { name: 'ok\x1b]0;never ended', input: 'a\x1b[', expect: { tool: 'x' } };
  const { run } = await ask(
    call('evals_run', { agentId: IDS.agent, version: 1, cases: [evalCase] }),
    [],
  );
  expect(run.stdout).toContain(
    '"ok<U+001B>]0;never ended" with input "a<U+001B>[" expecting {"tool":"x"}',
  );
  expect(controls(run.stdout)).toEqual([]);
});
