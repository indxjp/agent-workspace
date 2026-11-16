vi.mock('@indx-workspace/sdk/portable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@indx-workspace/sdk/portable')>();
  return { ...actual, diffBodies: vi.fn(actual.diffBodies) };
});

import {
  AgentVersionBodySchema,
  type AgentVersionBody,
} from '@indx-workspace/contracts/agent-versions';

import { diffBodies } from '@indx-workspace/sdk/portable';
import { expect, it, vi } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, IDS, json, runCli, type Route } from '../testing.js';
import {
  ARGV,
  DISABLED,
  TERMINAL,
  bodyOf,
  tool,
  agentFrame,
  status,
  DONE,
  message,
  call,
  SAVED,
  ask,
  controls,
} from './agents-new.fixture.test-support.js';

it('[US-BLD-06][api][cli] drops control sequences from streamed text and reveals them on the approval', async () => {
  const hostile =
    'safe\x1b[2Jtext\x1b]0;pwned\x07 and \x1b]8;;http://evil\x1b\\link\x1b]8;;\x1b\\ \x1bZ\x9b31m end\x00\x7f\u200b\u202e\u2066\u200fX';
  const toolStep = agentFrame(1, {
    frame: 'agent.tool.call',
    toolCallId: 't0',
    name: hostile,
    kind: 'other',
    input: { command: hostile, nested: [{ [hostile]: hostile }] },
  });
  const { run } = await ask(call('draft_save', { body: bodyOf(hostile) }), [], {
    before: message(hostile) + toolStep,
  });
  const shown = 'safetext and link 31m end<U+200B><U+202E><U+2066><U+200F>X';
  // The approval deletes nothing: an escape, its payload and the controls around it stay visible.
  const approved =
    'safe<U+001B>[2Jtext<U+001B>]0;pwned<U+0007> and <U+001B>]8;;http://evil<U+001B>\\\\link' +
    '<U+001B>]8;;<U+001B>\\\\ <U+001B>Z<U+009B>31m end<U+0000><U+007F><U+200B><U+202E><U+2066><U+200F>X';
  expect(run.stdout).toContain(`"${approved}"`);
  expect(run.stdout).toContain(`${shown}\n`);
  expect(run.stdout).toContain(`tool ${shown} (other) {"command":`);
  expect(run.stdout).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u);
  expect(controls(run.stdout)).toEqual([]);
});

it('[US-BLD-06][api][cli] says what the diff does not list when only the policy changes', async () => {
  const old = bodyOf('same');
  const policy = { ...old.definition.policy, limits: { maxTurns: 5, maxBudgetUsd: null } };
  const body = AgentVersionBodySchema.parse({
    ...old,
    definition: { ...old.definition, policy },
  });
  const draft = { agentId: IDS.agent, baseVersion: 1, body };
  const { run } = await ask(call('draft_save', draft), [], { versions: [old] });
  expect(run.stdout).toContain('(no changes in the listed sections)');
  expect(run.stdout).toContain('Also changes (not shown here): policy\n');
});

it('[US-BLD-06][api][cli] lists a permission mode change once, as a diff line', async () => {
  const old = bodyOf('same');
  const { policy } = old.definition;
  if (!('tools' in policy)) throw new Error('the fixture is a tool-rules policy');
  const tools = { ...policy.tools, permissionMode: 'acceptEdits' };
  const body = AgentVersionBodySchema.parse({
    ...old,
    definition: { ...old.definition, policy: { ...policy, tools } },
  });
  const draft = { agentId: IDS.agent, baseVersion: 1, body };
  const { run } = await ask(call('draft_save', draft), [], { versions: [old] });
  expect(run.stdout).toContain('policy  "definition.policy.tools.permissionMode"');
  expect(run.stdout).not.toContain('Also changes');
});

it('[US-BLD-06][api][cli] names the tool whose bundle changes outside the listed sections', async () => {
  const digest = 'a'.repeat(64);
  const bundles = (lookup: object, refund: object): AgentVersionBody =>
    AgentVersionBodySchema.parse({
      ...bodyOf('same'),
      toolBundles: [
        { tool: 'lookup', digest, ...lookup },
        { tool: 'refund', digest, ...refund },
      ],
    });
  const old = bundles({ description: 'Find an order' }, {});
  const draft = {
    agentId: IDS.agent,
    baseVersion: 1,
    body: bundles({}, { description: 'Find an order' }),
  };
  const { run } = await ask(call('draft_save', draft), [], { versions: [old] });
  expect(run.stdout).toContain(
    'Also changes (not shown here): toolBundles["lookup"], toolBundles["refund"]\n',
  );
});

it('counts only a draft_save result as a save', async () => {
  const lookalike =
    agentFrame(1, {
      frame: 'agent.tool.call',
      toolCallId: 't9',
      name: tool('draft_check'),
      kind: 'mcp',
      input: {},
    }) +
    agentFrame(2, {
      frame: 'agent.tool.result',
      toolCallId: 't9',
      status: 'completed',
      output: JSON.stringify(SAVED),
      isError: false,
    });
  const { run } = await ask(call('draft_save', { body: bodyOf('x') }), [], {
    before: lookalike,
  });
  expect(run.stdout).toContain('No draft was saved.');
  expect(run.stdout).not.toContain('Saved agent');
});

it('[US-BLD-06][api][cli] says the Builder is not enabled when the workspace has none', async () => {
  const route: Route = () => json(200, { agents: [FIXTURES.agent] });
  const run = await runCli(ARGV, { ...TERMINAL, prompt: () => Promise.resolve(''), route });
  expect(run.code).toBe(EXIT_CODE.problem);
  expect(run.stderr).toContain(DISABLED);
});

it('[US-BLD-06][api][cli] reveals nested diff values and keys, DEL and C1 included', async () => {
  const hostile = 'a\x1b]0;x\x07b\x7fc\x9b31md';
  // The shared diff lists scalars today; a section it gains later may carry arrays and objects.
  vi.mocked(diffBodies).mockReturnValueOnce([
    {
      section: 'tools',
      path: `tools[${hostile}]`,
      before: { [`k${hostile}`]: [hostile] },
      after: [{ nested: hostile }, hostile],
    },
  ]);
  const { run } = await ask(call('draft_save', { body: bodyOf('x') }), []);
  const shown = 'a<U+001B>]0;x<U+0007>b<U+007F>c<U+009B>31md';
  expect(run.stdout).toContain(`"tools[${shown}]"`);
  // A key is escaped by JSON (ESC and BEL print as \u001b and \u0007); the final pass reveals DEL and C1.
  expect(run.stdout).toContain('"ka\\u001b]0;x\\u0007b<U+007F>c<U+009B>31md":[');
  expect(run.stdout).toContain(`[{"nested":"${shown}"},"${shown}"]`);
  expect(controls(run.stdout)).toEqual([]);
});

it('[US-BLD-06][api][cli] strips control sequences from a run error on stderr', async () => {
  const hostile = 'boom\x1b[2Jbang\x1b]0;pwned\x07\x9b31m\x7f';
  const { run } = await ask(call('draft_save', { body: bodyOf('x') }), ['n'], {
    after: status(1, 'failed') + DONE,
    ended: 'failed',
    error: hostile,
  });
  expect(run.code).toBe(EXIT_CODE.problem);
  expect(run.stderr).toContain('failed: boombang31m\n');
  expect(controls(run.stderr)).toEqual([]);
});

it('[US-BLD-06][api][cli] strips control sequences from a server problem on stderr', async () => {
  const hostile = 'no\x1b[2Jpe\x1b]0;pwned\x07\x9b31m\x7f';
  const problem = { code: 'conflict', message: hostile, details: [hostile] };
  const run = await runCli(ARGV, {
    ...TERMINAL,
    prompt: () => Promise.resolve(''),
    route: () => json(409, { error: problem }),
  });
  expect(run.code).toBe(EXIT_CODE.problem);
  expect(run.stderr).toContain('conflict: nope31m\n  nope31m\n');
  expect(controls(run.stderr)).toEqual([]);
});
