import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { createOpenAiAgentsEngine } from './engine.js';

export const TOKEN = 'run-token-for-the-fake-gateway';

export const MCP_FIXTURE = path.join(
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

export function memoryStore(): EngineSessionStore & {
  entries(): readonly EngineTranscriptEntry[];
} {
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

export const gateway = new FakeGateway();

export const outbound: string[] = [];

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

export function workspace(files: Readonly<Record<string, string>>): string {
  root = mkdtempSync(path.join(tmpdir(), 'openai-agents-live-')).replaceAll('\\', '/');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
  return root;
}

export function requestFor(
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

export async function run(
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

export function toolFrames(frames: readonly EngineFrame[]): readonly ToolView[] {
  return frames.flatMap((frame): ToolView[] =>
    frame.frame === 'agent.tool.call'
      ? [{ frame: frame.frame, name: frame.name, kind: frame.kind }]
      : frame.frame === 'agent.tool.result'
        ? [{ frame: frame.frame, isError: frame.isError, output: frame.output }]
        : [],
  );
}

export const NODE_CHECK = `node -e "process.exit(require('fs').readFileSync('a.md','utf8').includes('world')?0:1)"`;
