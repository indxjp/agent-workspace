import type { EngineFrame } from '@agent-workspace/engine';
import { describe, expect, it } from 'vitest';
import { createOpenAiAgentsEngine } from './engine.js';
import { gateway, workspace, requestFor, run } from './boundary.fixture.test-support.js';

it('ends a looping agent at maxTurns with stopReason max_turns', async () => {
  const cwd = workspace({ 'a.md': 'x\n' });
  gateway.script([], { call: { name: 'read_file', args: { path: 'a.md' } } });

  const frames = await run(
    requestFor(cwd, 'openai-responses', {}, { limits: { maxTurns: 2, maxBudgetUsd: null } }),
  );

  expect(gateway.requests.length).toBeLessThanOrEqual(2);
  expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'max_turns' });
});

// ADR-0162 (#342): the spend ceiling is the gateway's. Every scripted response reports 10 input
// tokens and 5 output tokens, far past a 100 micro-dollar cap on any price, and the adapter still
// runs the loop to its turn limit: no budget stop is left in the adapter.
it('has no budget stop of its own: a spent cap runs on to maxTurns', async () => {
  const cwd = workspace({ 'a.md': 'x\n' });
  gateway.script([], { call: { name: 'read_file', args: { path: 'a.md' } } });

  const frames = await run(
    requestFor(
      cwd,
      'openai-responses',
      {},
      { model: 'gpt-5', limits: { maxTurns: 3, maxBudgetUsd: 0.0001 } },
    ),
  );

  expect(gateway.requests).toHaveLength(3);
  expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'max_turns' });
});

describe('subagents, as Agent.asTool', () => {
  const researcher = (model: string | null) => ({
    name: 'researcher',
    description: 'Reads files and reports.',
    instructions: 'You only research.',
    model,
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
  });
  const toolNames = (index: number): string[] =>
    (gateway.requests[index]?.body['tools'] as { name?: string }[]).flatMap((entry) =>
      entry.name === undefined ? [] : [entry.name],
    );

  it('delegates through subagent_<name> to an agent with the narrower tool set and its own instructions', async () => {
    const cwd = workspace({ 'a.md': 'x\n' });
    gateway.script([
      { call: { name: 'subagent_researcher', args: { input: 'Read a.md.' } } },
      { call: { name: 'read_file', args: { path: 'a.md' } } },
      { text: 'Found.' },
      { text: 'Done.' },
    ]);

    const frames = await run(
      requestFor(cwd, 'openai-responses', {}, { subagents: [researcher(null)] }),
    );

    expect(gateway.requests).toHaveLength(4);
    expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'end_turn' });
    expect(toolNames(0)).toEqual(expect.arrayContaining(['shell', 'subagent_researcher']));
    expect(toolNames(1)).toContain('read_file');
    expect(toolNames(1)).not.toContain('shell');
    expect(toolNames(1)).not.toContain('subagent_researcher');
    expect(JSON.stringify(gateway.requests[1]?.body)).toContain('You only research.');
    expect(JSON.stringify(gateway.requests[1]?.body)).toContain('Read a.md.');
  });

  it('adds the subagent’s usage to the run’s, and stops nothing at a cap', async () => {
    const cwd = workspace({ 'a.md': 'x\n' });
    gateway.script([
      { call: { name: 'subagent_researcher', args: { input: 'Read a.md.' } } },
      { text: 'Found.' },
      { text: 'Done.' },
    ]);

    const frames = await run(
      requestFor(
        cwd,
        'openai-responses',
        {},
        {
          model: 'gpt-5',
          limits: { maxTurns: 10, maxBudgetUsd: 0.0001 },
          subagents: [researcher('gpt-5')],
        },
      ),
    );

    // Two of the parent's responses and one of the subagent's: all reported, none stopped.
    expect(gateway.requests).toHaveLength(3);
    expect(frames.at(-1)).toMatchObject({
      frame: 'agent.result',
      stopReason: 'end_turn',
      turns: 2,
    });
    expect(frames.find((frame) => frame.frame === 'agent.usage')).toMatchObject({
      inputTokens: 30,
      outputTokens: 15,
    });
  });
});

it('runs to end_turn with a cap set', async () => {
  const cwd = workspace({ 'a.md': 'x\n' });
  gateway.script([{ call: { name: 'read_file', args: { path: 'a.md' } } }, { text: 'Done.' }]);

  const frames = await run(
    requestFor(
      cwd,
      'openai-responses',
      {},
      { model: 'gpt-5', limits: { maxTurns: null, maxBudgetUsd: 1 } },
    ),
  );

  expect(gateway.requests).toHaveLength(2);
  expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'end_turn' });
});
describe('outputSchema (ADR-0143)', () => {
  const SCHEMA = {
    type: 'object',
    properties: { verdict: { type: 'string' } },
    required: ['verdict'],
  };
  const textFormat = (index: number): unknown =>
    (gateway.requests[index]?.body['text'] as { format?: unknown } | undefined)?.format;

  it('sends the caller’s schema as the response format and reports the parsed answer', async () => {
    const cwd = workspace({});
    gateway.script([{ text: '{"verdict":"yes"}' }]);

    const frames = await run(requestFor(cwd, 'openai-responses', { outputSchema: SCHEMA }));

    expect(textFormat(0)).toMatchObject({
      type: 'json_schema',
      name: 'output',
      strict: false,
      schema: SCHEMA,
    });
    expect(frames.at(-1)).toMatchObject({
      frame: 'agent.result',
      stopReason: 'end_turn',
      output: { text: '{"verdict":"yes"}', structured: { verdict: 'yes' } },
    });
  });

  it.each([
    ['an answer that does not match the schema', '{"verdict":7}'],
    ['an answer that is not JSON', 'I think so.'],
  ])(
    'fails the run after the frames on %s, naming neither the schema nor the answer',
    async (_name, answer) => {
      const cwd = workspace({});
      gateway.script([{ text: answer }]);
      const connection = createOpenAiAgentsEngine().start(
        requestFor(cwd, 'openai-responses', { outputSchema: SCHEMA }),
        {},
      );
      const frames: EngineFrame[] = [];
      let failure: unknown;
      try {
        for await (const frame of connection.frames) frames.push(frame);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toMatch(/^output_schema_unsatisfied: /u);
      expect(message).not.toContain('verdict');
      expect(message).not.toContain(answer);
      const result = frames.at(-1);
      expect(result).toMatchObject({ frame: 'agent.result', stopReason: 'end_turn' });
      expect(result).not.toHaveProperty('output');
      expect(frames.some((frame) => frame.frame === 'agent.usage')).toBe(true);
    },
  );

  it('asks for no response format and reports structured: null without a schema', async () => {
    const cwd = workspace({});
    gateway.script([{ text: 'Plain answer.' }]);

    const frames = await run(requestFor(cwd, 'openai-responses'));

    expect(textFormat(0)).toBeUndefined();
    expect(frames.at(-1)).toMatchObject({
      frame: 'agent.result',
      output: { text: 'Plain answer.', structured: null },
    });
  });
});
