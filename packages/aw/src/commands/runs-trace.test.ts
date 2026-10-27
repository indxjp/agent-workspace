import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { eventStream, IDS, json, runCli, runFixture, stdoutJson, type Route } from '../testing.js';

const frame = (event: string, id: number, data: unknown): string =>
  `event: ${event}\nid: ${String(id)}\ndata: ${JSON.stringify(data)}\n\n`;

const agentFrame = (id: number, name: string, fields: Record<string, unknown>): string =>
  frame(name, id, { frame: name, engine: 'claude-agent-sdk', raw: { type: 'relayed' }, ...fields });

const message = (id: number, messageId: string | null, text: string, role = 'assistant'): string =>
  agentFrame(id, 'agent.message', { messageId, role, blocks: [{ type: 'text', text }] });

const call = (id: number, toolCallId: string, name: string, kind: string, input: unknown): string =>
  agentFrame(id, 'agent.tool.call', { toolCallId, name, kind, input });

const answer = (id: number, toolCallId: string, output: string, failed = false): string =>
  agentFrame(id, 'agent.tool.result', {
    toolCallId,
    status: failed ? 'failed' : 'completed',
    output,
    isError: failed,
  });

const usage = (id: number, inputTokens: number, outputTokens: number): string =>
  agentFrame(id, 'agent.usage', {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    reasoningTokens: null,
  });

const result = (id: number): string =>
  agentFrame(id, 'agent.result', { stopReason: 'end_turn', turns: 2, engineCostUsd: 0.0125 });

/** The same frame as the server writes it once it stamps the time the event was recorded. */
const at = (seconds: number, text: string): string =>
  text.replace(
    '\ndata:',
    `\nat: ${new Date(Date.UTC(2026, 9, 13, 10, 0, 0) + seconds * 1000).toISOString()}\ndata:`,
  );

const END = 'event: done\ndata: null\n\n';

const SETTLED = {
  ...runFixture('completed'),
  durationMs: 1200,
  usage: {
    inputTokens: 150,
    outputTokens: 25,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 175,
    toolCalls: 2,
  },
  cost: { amount: '0.012500', currency: 'USD', priceTableVersion: 'v1' },
  output: null,
  accountingState: 'complete',
};

const routes =
  (stream: string, run: unknown = SETTLED): Route =>
  (request) =>
    request.url.pathname.endsWith('/events') ? eventStream(stream) : json(200, { run });

const trace = (stream: string, run?: unknown, flags: readonly string[] = []) =>
  runCli(['runs', 'trace', IDS.run, ...flags], { route: routes(stream, run) });

describe('aw runs trace', () => {
  it('prints steps and tool calls as a tree, with inputs, outputs, tokens and cost', async () => {
    const run = await trace(
      frame('run.status', 1, { status: 'running', error: null }) +
        message(2, 'msg_1', 'Reading the incidents.') +
        call(3, 'toolu_1', 'Read', 'read', { path: 'incidents.md' }) +
        answer(4, 'toolu_1', 'two open') +
        call(5, 'toolu_2', 'Grep', 'search', { q: 'x' }) +
        answer(6, 'toolu_2', 'boom', true) +
        message(7, 'msg_2', 'Two open.') +
        usage(8, 150, 25) +
        result(9) +
        END,
    );
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout.split('\n')).toEqual([
      `run ${IDS.run} completed 1200ms tokens=175 cost=0.012500 USD`,
      '├─ step 1: Reading the incidents.',
      '│  ├─ Read (read) completed',
      '│  │     input: {"path":"incidents.md"}',
      '│  │     output: two open',
      '│  └─ Grep (search) failed (error)',
      '│        input: {"q":"x"}',
      '│        output: boom',
      '├─ step 2: Two open.',
      '└─ result stop=end_turn turns=2 engine-tokens=150/25 engine-cost=$0.0125 (estimate)',
      '',
    ]);
    expect(run.calls.map((entry) => entry.url.pathname)).toEqual([
      `/api/runs/${IDS.run}/events`,
      `/api/runs/${IDS.run}`,
    ]);
  });

  it('replaces a step whose messageId repeats, and keeps a null messageId as its own step', async () => {
    const run = await trace(
      message(1, 'msg_1', 'Read') +
        message(2, 'msg_1', 'Reading the incidents.') +
        message(3, null, 'one') +
        message(4, null, 'two') +
        END,
    );
    expect(run.stdout.split('\n').slice(1)).toEqual([
      '├─ step 1: Reading the incidents.',
      '├─ step 2: one',
      '└─ step 3: two',
      '',
    ]);
  });

  it('puts a call that precedes any message in a first step, and shows a result with no call', async () => {
    const run = await trace(
      call(1, 'toolu_1', 'Read', 'read', { path: 'a' }) +
        answer(2, 'toolu_1', 'ok') +
        answer(3, 'toolu_ghost', 'late') +
        END,
    );
    expect(run.stdout.split('\n').slice(1)).toEqual([
      '└─ step 1',
      '   ├─ Read (read) completed',
      '   │     input: {"path":"a"}',
      '   │     output: ok',
      '   └─ (no call) toolu_ghost completed',
      '         output: late',
      '',
    ]);
  });

  it('shows a call that never got a result, and cuts a long output to one line', async () => {
    const run = await trace(
      message(1, 'msg_1', 'go') +
        call(2, 'toolu_1', 'Read', 'read', {}) +
        call(3, 'toolu_2', 'Bash', 'execute', { command: 'cat big' }) +
        answer(4, 'toolu_2', `first\nsecond ${'x'.repeat(400)}`) +
        END,
    );
    const lines = run.stdout.split('\n');
    expect(lines).toContain('   ├─ Read (read) no result');
    const output = lines.find((line) => line.includes('output: first second'));
    expect(output).toBeDefined();
    expect(output?.endsWith('…')).toBe(true);
    expect(output?.length).toBeLessThan(260);
  });

  it('ignores the frames it does not draw', async () => {
    const run = await trace(
      frame('run.status', 1, { status: 'running', error: null }) +
        agentFrame(2, 'agent.session', { engineSessionId: 'ses_abc', model: null }) +
        agentFrame(3, 'agent.message.delta', {
          messageId: 'msg_1',
          block: 'text',
          text: 'Rea',
        }) +
        agentFrame(4, 'agent.native', { type: 'rate_limit', payload: null }) +
        frame('stream-reset', 5, { reason: 'gap', resumedAfter: null }) +
        message(6, 'msg_1', 'Reading.', 'assistant') +
        message(7, 'msg_u', 'a question', 'user') +
        END,
    );
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout.split('\n').slice(1)).toEqual(['└─ step 1: Reading.', '']);
  });

  it('labels a run whose accounting is not complete', async () => {
    const run = await trace(END, { ...SETTLED, accountingState: 'partial' });
    expect(run.stdout.split('\n')[0]).toBe(
      `run ${IDS.run} completed 1200ms tokens=175 cost=0.012500 USD (accounting partial)`,
    );
  });

  it('--json prints the structured tree', async () => {
    const run = await trace(
      message(1, 'msg_1', 'Reading.') +
        call(2, 'toolu_1', 'Read', 'read', { path: 'a' }) +
        answer(3, 'toolu_1', 'ok') +
        usage(4, 10, 2) +
        result(5) +
        END,
      undefined,
      ['--json'],
    );
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(stdoutJson(run)).toMatchObject({
      run: { id: IDS.run, usage: { totalTokens: 175 }, cost: { amount: '0.012500' } },
      steps: [
        {
          messageId: 'msg_1',
          text: 'Reading.',
          toolCalls: [
            {
              toolCallId: 'toolu_1',
              name: 'Read',
              kind: 'read',
              input: { path: 'a' },
              status: 'completed',
              output: 'ok',
              isError: false,
            },
          ],
        },
      ],
      engineUsage: { inputTokens: 10, outputTokens: 2 },
      result: { stopReason: 'end_turn', turns: 2, engineCostUsd: 0.0125 },
    });
  });

  it('prints each step, tool call and the result as an offset from the run start, with tool durations', async () => {
    const run = await trace(
      at(0.5, message(1, 'msg_1', 'Reading.')) +
        at(12.4, call(2, 'toolu_1', 'Read', 'read', { path: 'a' })) +
        at(13.2, answer(3, 'toolu_1', 'ok')) +
        at(14, call(4, 'toolu_2', 'Grep', 'search', { q: 'x' })) +
        at(41.7, result(5)) +
        END,
      { ...SETTLED, startedAt: '2026-10-13T10:00:00.000Z' },
    );
    expect(run.stdout.split('\n').slice(1)).toEqual([
      '├─ step 1 +0.5s: Reading.',
      '│  ├─ Read (read) completed +12.4s 800ms',
      '│  │     input: {"path":"a"}',
      '│  │     output: ok',
      '│  └─ Grep (search) no result +14.0s',
      '│        input: {"q":"x"}',
      '└─ result stop=end_turn +41.7s turns=2 engine-cost=$0.0125 (estimate)',
      '',
    ]);
  });

  it('counts from the first stamped event when the run has no start time', async () => {
    const run = await trace(
      at(100, message(1, 'msg_1', 'one')) + at(103.25, message(2, 'msg_2', 'two')) + END,
    );
    expect(run.stdout.split('\n').slice(1)).toEqual([
      '├─ step 1 +0.0s: one',
      '└─ step 2 +3.3s: two',
      '',
    ]);
  });

  it('counts from the result when it is the only stamped event and the run has no start time', async () => {
    const run = await trace(message(1, 'msg_1', 'one') + at(7, result(2)) + END);
    expect(run.stdout.split('\n').slice(1)).toEqual([
      '├─ step 1: one',
      '└─ result stop=end_turn +0.0s turns=2 engine-cost=$0.0125 (estimate)',
      '',
    ]);
  });

  it('--json carries the stamps', async () => {
    const run = await trace(
      at(1, message(1, 'msg_1', 'Reading.')) +
        at(2, call(2, 'toolu_1', 'Read', 'read', {})) +
        at(3, answer(3, 'toolu_1', 'ok')) +
        at(4, result(4)) +
        END,
      undefined,
      ['--json'],
    );
    const stamp = (seconds: number): string =>
      new Date(Date.UTC(2026, 9, 13, 10, 0, seconds)).toISOString();
    expect(stdoutJson(run)).toMatchObject({
      steps: [
        {
          at: stamp(1),
          toolCalls: [{ calledAt: stamp(2), answeredAt: stamp(3) }],
        },
      ],
      result: { at: stamp(4) },
    });
  });

  it('exits with the problem code for a run that is not found, and refuses a missing id', async () => {
    const missing = await runCli(['runs', 'trace', IDS.run], {
      route: () => json(404, { error: { code: 'run_not_found', message: 'No such run.' } }),
    });
    expect(missing.code).toBe(EXIT_CODE.problem);
    expect(missing.stderr).toContain('run_not_found');
    expect(missing.stdout).toBe('');

    const bare = await runCli(['runs', 'trace']);
    expect(bare.code).toBe(EXIT_CODE.usage);
    expect(bare.calls).toHaveLength(0);
  });
});
