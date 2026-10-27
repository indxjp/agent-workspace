/**
 * The real OpenAI Agents SDK, run through this adapter against a fake gateway (ENG-09, #308).
 *
 * The conformance kit drives the adapter with replayed events; this suite drives the **SDK** —
 * `OpenAIProvider`, `aisdk(createAnthropic(…))`, `Runner`, function tools, `MCPServerStdio` and the
 * `Session` — against an HTTP server that answers in the wire protocol each connection speaks. The
 * fixtures are hand-authored from the published event schemas (as
 * `docs/compatibility/openai-ingress.md` records for the gateway's own fixtures); no live
 * credential is used. What the suite proves is the adapter's half of each acceptance criterion:
 *
 *  * a Responses run that reads, patches and tests a file streams the expected `agent.*` frames;
 *  * the Anthropic Messages path authenticates with `Authorization: Bearer <run token>` and no
 *    `x-api-key`;
 *  * a stdio connector's tool is called and reported `kind: 'mcp'`;
 *  * every request the process makes goes to the gateway — no trace export, no other host — and
 *    `setTracingDisabled(true)` precedes the run;
 *  * a write under a read-only grant is refused by our Editor and the file is unchanged;
 *  * a second run on the session sees the first run's items;
 *  * `maxTurns: 2` ends a looping agent with `stopReason: 'max_turns'`, and a spent provisional
 *    budget ends one with `stopReason: 'max_budget'`.
 *
 * That the **gateway** records `wire_protocol` for each request is the gateway's own suite
 * (`packages/gateway`, ADR-0068 D5); here it is enough that each request arrives on the route that
 * protocol is metered on.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type {
  EngineFrame,
  EngineRunRequest,
  EngineSessionKey,
  EngineSessionStore,
  EngineTranscriptEntry,
} from '@agent-workspace/engine';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createOpenAiAgentsEngine } from './engine.js';

const TOKEN = 'run-token-for-the-fake-gateway';
const MCP_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'mcp-echo-server.mjs',
);

type Recorded = {
  readonly path: string;
  readonly authorization: string | null;
  readonly apiKeyHeader: string | null;
  readonly body: Record<string, unknown>;
};

/** One scripted model turn, in the neutral terms the two protocol renderers read. */
type Answer =
  | { readonly call: { readonly name: string; readonly args: Record<string, unknown> } }
  | { readonly text: string };
type Turn = Answer | { readonly refuse: { readonly status: number; readonly code?: string } };

function sse(events: readonly Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

function responsesStream(turn: Answer, index: number): string {
  const id = `resp_${String(index)}`;
  const usage = {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 1 },
  };
  if ('call' in turn) {
    const item = {
      type: 'function_call',
      id: `fc_${String(index)}`,
      call_id: `call_${String(index)}`,
      name: turn.call.name,
      arguments: JSON.stringify(turn.call.args),
      status: 'completed',
    };
    return sse([
      {
        type: 'response.created',
        response: { id, object: 'response', status: 'in_progress', output: [] },
      },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: { id, object: 'response', status: 'completed', output: [item], usage },
      },
    ]);
  }
  const message = {
    type: 'message',
    id: `msg_${String(index)}`,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: turn.text, annotations: [] }],
  };
  return sse([
    {
      type: 'response.created',
      response: { id, object: 'response', status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...message, status: 'in_progress', content: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: turn.text,
    },
    { type: 'response.output_item.done', output_index: 0, item: message },
    {
      type: 'response.completed',
      response: { id, object: 'response', status: 'completed', output: [message], usage },
    },
  ]);
}

function messagesStream(turn: Answer, index: number): string {
  const start = {
    type: 'message_start',
    message: {
      id: `msg_${String(index)}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  };
  if ('call' in turn) {
    return sse([
      start,
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: `toolu_${String(index)}`,
          name: turn.call.name,
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(turn.call.args) },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      { type: 'message_stop' },
    ]);
  }
  return sse([
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: 'message_stop' },
  ]);
}

/** The fake gateway: answers `/v1/responses` and `/v1/messages` from a script, records every request. */
class FakeGateway {
  readonly requests: Recorded[] = [];
  #script: Turn[] = [];
  #loop: Turn | null = null;
  #served = 0;
  #server: Server | null = null;
  baseUrl = '';

  script(turns: readonly Turn[], loop: Turn | null = null): void {
    this.#script = [...turns];
    this.#loop = loop;
    this.#served = 0;
    this.requests.length = 0;
  }

  async start(): Promise<void> {
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    const address = this.#server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${String(address.port)}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    this.requests.push({
      path: request.url ?? '',
      authorization: request.headers.authorization ?? null,
      apiKeyHeader: (request.headers['x-api-key'] as string | undefined) ?? null,
      body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
    });
    const turn = this.#script[this.#served] ?? this.#loop;
    const index = this.#served;
    this.#served += 1;
    if (turn === null || turn === undefined) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'the fake gateway script is exhausted' } }));
      return;
    }
    if ('refuse' in turn) {
      response.writeHead(turn.refuse.status, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { message: 'refused', code: turn.refuse.code ?? 'invalid_api_key' },
        }),
      );
      return;
    }
    const body =
      request.url === '/v1/responses'
        ? responsesStream(turn, index)
        : request.url === '/v1/messages'
          ? messagesStream(turn, index)
          : null;
    if (body === null) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `no route ${String(request.url)}` } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(body);
  }
}

/** A complete in-memory store, keyed like the platform's (`projectKey/subpath`, session). */
function memoryStore(): EngineSessionStore & { entries(): readonly EngineTranscriptEntry[] } {
  const streams = new Map<string, EngineTranscriptEntry[]>();
  const keyOf = (key: EngineSessionKey) =>
    `${key.sessionId}:${key.projectKey}/${key.subpath ?? ''}`;
  return {
    entries: () => [...streams.values()].flat(),
    append(key, entries) {
      streams.set(keyOf(key), [...(streams.get(keyOf(key)) ?? []), ...entries]);
      return Promise.resolve();
    },
    load(key) {
      return Promise.resolve(streams.get(keyOf(key)) ?? null);
    },
    deleteLast(key) {
      streams.set(keyOf(key), (streams.get(keyOf(key)) ?? []).slice(0, -1));
      return Promise.resolve();
    },
    replaceAll(key, entries) {
      streams.set(keyOf(key), [...entries]);
      return Promise.resolve();
    },
  };
}

const gateway = new FakeGateway();
const outbound: string[] = [];
const realFetch = globalThis.fetch;
let root = '';

beforeAll(async () => {
  // `@ai-sdk/anthropic` reads `ANTHROPIC_BASE_URL` when the boundary first loads it, and refuses an
  // empty one; the Anthropic scenario must not depend on what the ambient environment exports.
  vi.stubEnv('ANTHROPIC_BASE_URL', undefined);
  await gateway.start();
  // Every request the process makes, whatever issued it: the SDK's clients and a tracing
  // exporter would all go through `fetch`.
  globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    outbound.push(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    return realFetch(input, init);
  };
});

afterAll(async () => {
  vi.unstubAllEnvs();
  globalThis.fetch = realFetch;
  await gateway.stop();
});

afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

function workspace(files: Readonly<Record<string, string>>): string {
  root = mkdtempSync(path.join(tmpdir(), 'openai-agents-live-')).replaceAll('\\', '/');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
  return root;
}

function requestFor(
  cwd: string,
  protocol: 'openai-responses' | 'anthropic-messages',
  overrides: Partial<EngineRunRequest> = {},
  portable: Partial<EngineRunRequest['portable']> = {},
): EngineRunRequest {
  return {
    runId: '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b',
    sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
    projectKey: 'tenant-a',
    cwd,
    prompt: 'read a.md, fix it and test it',
    engine: 'openai-agents',
    portable: {
      name: 'Live agent',
      instructions: 'You edit files.',
      model: protocol === 'anthropic-messages' ? 'claude-test' : 'gpt-test',
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: false,
      },
      skills: { mode: 'allowlist', names: [] },
      mcpServers: {},
      limits: { maxTurns: null, maxBudgetUsd: null },
      ...portable,
    },
    policy: {},
    session: { mode: 'fresh' },
    gateway: { baseUrl: gateway.baseUrl, token: TOKEN, protocol },
    resources: { files: [], skills: [] },
    env: {
      PATH: process.env['PATH'] ?? '',
      ...(process.env['SystemRoot'] === undefined ? {} : { SystemRoot: process.env['SystemRoot'] }),
    },
    ...overrides,
  };
}

async function run(
  request: EngineRunRequest,
  sessionStore?: EngineSessionStore,
): Promise<readonly EngineFrame[]> {
  const connection = createOpenAiAgentsEngine().start(
    request,
    sessionStore === undefined ? {} : { sessionStore },
  );
  const frames: EngineFrame[] = [];
  for await (const frame of connection.frames) frames.push(frame);
  return frames;
}

type ToolView = {
  readonly frame: string;
  readonly name?: string;
  readonly kind?: string;
  readonly isError?: boolean;
  readonly output?: string;
};

function toolFrames(frames: readonly EngineFrame[]): readonly ToolView[] {
  return frames.flatMap((frame): ToolView[] =>
    frame.frame === 'agent.tool.call'
      ? [{ frame: frame.frame, name: frame.name, kind: frame.kind }]
      : frame.frame === 'agent.tool.result'
        ? [{ frame: frame.frame, isError: frame.isError, output: frame.output }]
        : [],
  );
}

const NODE_CHECK = `node -e "process.exit(require('fs').readFileSync('a.md','utf8').includes('world')?0:1)"`;

describe('the real SDK behind the adapter', () => {
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
    expect(gateway.requests.map((request) => request.path)).toEqual([
      '/v1/messages',
      '/v1/messages',
    ]);
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

  it('calls an assigned stdio connector and reports it as an mcp tool call', async () => {
    const cwd = workspace({});
    gateway.script([{ call: { name: 'echo', args: { text: 'hi' } } }, { text: 'Echoed.' }]);

    const frames = await run(
      requestFor(
        cwd,
        'openai-responses',
        {},
        {
          mcpServers: { echo: { type: 'stdio', command: process.execPath, args: [MCP_FIXTURE] } },
        },
      ),
    );

    expect(toolFrames(frames)).toEqual([
      { frame: 'agent.tool.call', name: 'echo', kind: 'mcp' },
      {
        frame: 'agent.tool.result',
        isError: false,
        output: expect.stringContaining('echo: hi') as unknown,
      },
    ]);
  });

  it('refuses a write under a read-only grant in the Editor and leaves the file unchanged', async () => {
    const cwd = workspace({ 'docs/spec.md': 'original\n' });
    gateway.script([
      {
        call: {
          name: 'apply_patch',
          args: {
            type: 'update_file',
            path: 'docs/spec.md',
            diff: '@@\n-original\n+changed\n',
            moveTo: null,
          },
        },
      },
      { text: 'Could not.' },
    ]);

    const frames = await run(
      requestFor(cwd, 'openai-responses', {
        resources: { files: [{ kind: 'directory', path: 'docs', access: 'read' }], skills: [] },
      }),
    );

    const result = frames.find((frame) => frame.frame === 'agent.tool.result');
    expect(result).toMatchObject({ isError: true });
    expect(readFileSync(path.join(cwd, 'docs/spec.md'), 'utf8')).toBe('original\n');
    // `shell` is withheld while a read-only grant exists (ADR-0074 D2).
    const tools = (gateway.requests[0]?.body['tools'] as { name: string }[]).map(
      (tool) => tool.name,
    );
    expect(tools).not.toContain('shell');
  });

  it('resumes a session: the second run sees the first run’s items', async () => {
    const cwd = workspace({});
    const store = memoryStore();
    gateway.script([{ text: 'First answer.' }]);
    await run(requestFor(cwd, 'openai-responses', { prompt: 'remember the word teal' }), store);
    expect(store.entries().length).toBeGreaterThan(0);

    gateway.script([{ text: 'Second answer.' }]);
    await run(
      requestFor(cwd, 'openai-responses', {
        prompt: 'which word?',
        session: { mode: 'resume', engineSessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e' },
      }),
      store,
    );

    const input = JSON.stringify(gateway.requests[0]?.body['input']);
    expect(input).toContain('remember the word teal');
    expect(input).toContain('First answer.');
    expect(input).toContain('which word?');
  });

  it('ends a looping agent at maxTurns with stopReason max_turns', async () => {
    const cwd = workspace({ 'a.md': 'x\n' });
    gateway.script([], { call: { name: 'read_file', args: { path: 'a.md' } } });

    const frames = await run(
      requestFor(cwd, 'openai-responses', {}, { limits: { maxTurns: 2, maxBudgetUsd: null } }),
    );

    expect(gateway.requests.length).toBeLessThanOrEqual(2);
    expect(frames.at(-1)).toMatchObject({ frame: 'agent.result', stopReason: 'max_turns' });
  });

  // The provisional budget cap (ADR-0074 D7, #342). Every scripted response reports 10 input
  // tokens (2 cached) and 5 output tokens; on gpt-5's provisional rates that is 60.25 micro-dollars
  // a response, so a 100 micro-dollar cap is reached by the second response.
  it('stops a looping agent with stopReason max_budget once the reported usage reaches the cap', async () => {
    const cwd = workspace({ 'a.md': 'x\n' });
    gateway.script([], { call: { name: 'read_file', args: { path: 'a.md' } } });

    const frames = await run(
      requestFor(
        cwd,
        'openai-responses',
        {},
        { model: 'gpt-5', limits: { maxTurns: 10, maxBudgetUsd: 0.0001 } },
      ),
    );

    expect(gateway.requests).toHaveLength(2);
    expect(frames.at(-1)).toMatchObject({
      frame: 'agent.result',
      stopReason: 'max_budget',
      turns: 2,
    });
    expect(frames.find((frame) => frame.frame === 'agent.usage')).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
    });
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

    it('counts the subagent’s usage against the cap and stops the run', async () => {
      const cwd = workspace({ 'a.md': 'x\n' });
      gateway.script([], { call: { name: 'subagent_researcher', args: { input: 'Read a.md.' } } });

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

      // The parent's call is one response, the subagent's first step the second: that reaches the cap.
      expect(gateway.requests).toHaveLength(2);
      expect(frames.at(-1)).toMatchObject({
        frame: 'agent.result',
        stopReason: 'max_budget',
        turns: 1,
      });
      expect(frames.find((frame) => frame.frame === 'agent.usage')).toMatchObject({
        inputTokens: 20,
        outputTokens: 10,
      });
    });
  });

  it('runs to end_turn when the reported usage stays under the cap', async () => {
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
});
