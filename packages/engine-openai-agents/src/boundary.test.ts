import { readFileSync } from 'node:fs';

import path from 'node:path';

import { expect, it } from 'vitest';

import {
  TOKEN,
  gateway,
  outbound,
  workspace,
  requestFor,
  run,
  toolFrames,
  NODE_CHECK,
} from './boundary.fixture.test-support.js';

it('reads, patches and tests a file over Responses, with every request on the gateway', async () => {
  const cwd = workspace({ 'a.md': 'hello\n' });
  gateway.script([
    { call: { name: 'read_file', args: { path: 'a.md' } } },
    {
      call: {
        name: 'apply_patch',
        args: {
          type: 'update_file',
          path: 'a.md',
          diff: '@@\n-hello\n+hello world\n',
          moveTo: null,
        },
      },
    },
    { call: { name: 'shell', args: { commands: [NODE_CHECK], timeoutMs: null } } },
    { text: 'Fixed and tested.' },
  ]);
  outbound.length = 0;

  const frames = await run(requestFor(cwd, 'openai-responses'));

  expect(readFileSync(path.join(cwd, 'a.md'), 'utf8')).toBe('hello world\n');
  expect(toolFrames(frames)).toEqual([
    { frame: 'agent.tool.call', name: 'read_file', kind: 'read' },
    { frame: 'agent.tool.result', isError: false, output: 'hello\n' },
    { frame: 'agent.tool.call', name: 'apply_patch', kind: 'edit' },
    { frame: 'agent.tool.result', isError: false, output: 'updated a.md' },
    { frame: 'agent.tool.call', name: 'shell', kind: 'execute' },
    {
      frame: 'agent.tool.result',
      isError: false,
      output: expect.stringContaining('[exit 0]') as unknown,
    },
  ]);
  expect(frames.find((frame) => frame.frame === 'agent.message.delta')).toMatchObject({
    block: 'text',
    text: 'Fixed and tested.',
  });
  expect(frames.at(-2)).toMatchObject({
    frame: 'agent.usage',
    inputTokens: 40,
    outputTokens: 20,
  });
  expect(frames.at(-1)).toMatchObject({
    frame: 'agent.result',
    stopReason: 'end_turn',
    turns: 4,
  });
  for (const frame of frames) expect(frame.engine).toBe('openai-agents');

  // Egress: four model requests, all on the Responses route, all with the run token.
  expect(gateway.requests.map((request) => request.path)).toEqual(Array(4).fill('/v1/responses'));
  for (const request of gateway.requests) expect(request.authorization).toBe(`Bearer ${TOKEN}`);
  for (const request of gateway.requests) {
    for (const tool of request.body['tools'] as { type: string }[])
      expect(tool.type).toBe('function');
  }
  // No trace endpoint, no other host: every request this process made went to the gateway.
  expect(outbound.length).toBeGreaterThanOrEqual(4);
  for (const url of outbound) expect(url.startsWith(`${gateway.baseUrl}/v1/`)).toBe(true);
  // ADR-0074 D4: tracing is disabled before the run starts. Read from the boundary's source,
  // because this suite may not name the SDK itself (`tests/no-sdk-import.test.ts` permits
  // exactly the boundary file): the module disables it on load, and the run function disables
  // it again before it builds a `Runner` or calls `run`.
  const source = readFileSync(new URL('./boundary.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function* startOpenAiAgentsRun(');
  expect(source.indexOf('setTracingDisabled(true);')).toBeLessThan(start);
  const body = source.slice(start);
  expect(body.indexOf('setTracingDisabled(true);')).toBeGreaterThan(0);
  expect(body.indexOf('setTracingDisabled(true);')).toBeLessThan(body.indexOf('new Runner('));
  expect(body.indexOf('new Runner(')).toBeLessThan(body.indexOf('runner.run('));
});

it('reaches an Anthropic-family connection over Messages with the run token as a bearer', async () => {
  const cwd = workspace({ 'a.md': 'hello\n' });
  gateway.script([{ call: { name: 'read_file', args: { path: 'a.md' } } }, { text: 'Read it.' }]);
  outbound.length = 0;

  const frames = await run(requestFor(cwd, 'anthropic-messages'));

  expect(toolFrames(frames)).toEqual([
    { frame: 'agent.tool.call', name: 'read_file', kind: 'read' },
    { frame: 'agent.tool.result', isError: false, output: 'hello\n' },
  ]);
  expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'end_turn' });
  expect(gateway.requests.map((request) => request.path)).toEqual(['/v1/messages', '/v1/messages']);
  for (const request of gateway.requests) {
    expect(request.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request.apiKeyHeader).toBeNull();
  }
  for (const url of outbound) expect(url.startsWith(`${gateway.baseUrl}/v1/`)).toBe(true);
});

it.each(['openai-responses', 'anthropic-messages'] as const)(
  'fails a %s run fast and clearly when the provider rejects the key, without echoing it',
  async (protocol) => {
    const cwd = workspace({ 'a.md': 'x' });
    gateway.script([{ refuse: { status: 401 } }]);

    const failure = await run(requestFor(cwd, protocol)).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : failure).toBe(
      'model_credential_rejected: the model provider rejected the API key (HTTP 401).',
    );
    expect(gateway.requests).toHaveLength(1);
  },
);

it("leaves the gateway's own token refusal uncoded", async () => {
  const cwd = workspace({ 'a.md': 'x' });
  gateway.script([{ refuse: { status: 401, code: 'token_expired' } }]);

  const failure = await run(requestFor(cwd, 'openai-responses')).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).not.toContain('model_credential_rejected');
});
