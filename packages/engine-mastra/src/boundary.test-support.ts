import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { EngineFrame, EngineRunRequest } from '@agent-workspace/engine';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

import { preloadMastra } from './boundary.js';

export const GATEWAY = 'http://gateway.invalid';
export const TOKEN = 'run-token-for-mastra';

type Seen = {
  readonly url: string;
  readonly authorization: string | null;
  readonly apiKey: string | null;
  readonly body: unknown;
};

export const scriptedGateway: {
  seen: Seen[];
  script: (Response | ((signal: AbortSignal | undefined) => Response))[];
} = { seen: [], script: [] };
const realFetch = globalThis.fetch;

export function sse(events: readonly Record<string, unknown>[]): Response {
  const body = events
    .map((event) => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function anthropicTurn(
  content: 'tool' | 'text',
  value: { id?: string; name?: string; input?: unknown; text?: string },
): Response {
  const start = {
    type: 'message_start',
    message: {
      id: `msg_${String(scriptedGateway.seen.length)}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 100, output_tokens: 1 },
    },
  };
  const block =
    content === 'tool'
      ? [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: value.id, name: value.name, input: {} },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(value.input) },
          },
        ]
      : [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: value.text },
          },
        ];
  return sse([
    start,
    ...block,
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: content === 'tool' ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: 10 },
    },
    { type: 'message_stop' },
  ]);
}

/**
 * A Messages stream that sends its first text delta and then holds the connection open until the
 * request is aborted: the shape of a model still answering when the caller interrupts.
 */
export function slowText(first: string): (signal: AbortSignal | undefined) => Response {
  return (signal) => {
    const encoder = new TextEncoder();
    const frame = (event: Record<string, unknown>): Uint8Array =>
      encoder.encode(`event: ${String(event['type'])}
data: ${JSON.stringify(event)}

`);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          frame({
            type: 'message_start',
            message: {
              id: 'msg_slow',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-4-5',
              content: [],
              stop_reason: null,
              usage: { input_tokens: 100, output_tokens: 1 },
            },
          }),
        );
        controller.enqueue(
          frame({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }),
        );
        controller.enqueue(
          frame({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: first },
          }),
        );
        const abort = (): void => {
          controller.error(signal?.reason ?? new DOMException('aborted', 'AbortError'));
        };
        if (signal?.aborted === true) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

export const tool = (id: string, name: string, input: unknown): Response =>
  anthropicTurn('tool', { id, name, input });
export const text = (value: string): Response => anthropicTurn('text', { text: value });

export function chatCompletion(value: string): Response {
  const chunks = [
    {
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-5',
      choices: [{ index: 0, delta: { role: 'assistant', content: value }, finish_reason: null }],
    },
    {
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-5',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** One OpenAI Responses stream answering `value` as a single text message. */
export function responsesText(value: string): Response {
  const message = {
    type: 'message',
    id: 'msg_r1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: value, annotations: [] }],
  };
  const usage = { input_tokens: 5, output_tokens: 2, total_tokens: 7 };
  return sse([
    {
      type: 'response.created',
      response: { id: 'resp_1', created_at: 1, model: 'gpt-5', status: 'in_progress', output: [] },
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
      delta: value,
    },
    { type: 'response.output_item.done', output_index: 0, item: message },
    {
      type: 'response.completed',
      response: { id: 'resp_1', object: 'response', status: 'completed', output: [message], usage },
    },
  ]);
}

async function gatewayFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  const raw = input instanceof Request ? await input.text() : init?.body;
  scriptedGateway.seen.push({
    url,
    authorization: headers.get('authorization'),
    apiKey: headers.get('x-api-key'),
    body: typeof raw === 'string' && raw.length > 0 ? JSON.parse(raw) : null,
  });
  const next = scriptedGateway.script.shift();
  if (next === undefined || !url.startsWith(GATEWAY)) {
    return new Response(JSON.stringify({ error: 'unscripted' }), { status: 500 });
  }
  return typeof next === 'function'
    ? next(input instanceof Request ? input.signal : (init?.signal ?? undefined))
    : next;
}

const roots: string[] = [];

export function workspace(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mastra-boundary-')));
  roots.push(root);
  writeFileSync(path.join(root, 'a.md'), 'hello doc\n');
  mkdirSync(path.join(root, 'contracts'));
  writeFileSync(path.join(root, 'contracts/signed.pdf'), 'signed');
  mkdirSync(path.join(root, '.mastra/skills/greeter'), { recursive: true });
  writeFileSync(
    path.join(root, '.mastra/skills/greeter/SKILL.md'),
    '---\nname: greeter\ndescription: Greets people the house way.\n---\n# Greeter\nAlways greet with "Ahoy".\n',
  );
  return root;
}

export function request(cwd: string, overrides: Partial<EngineRunRequest> = {}): EngineRunRequest {
  return {
    runId: 'run-1',
    sessionId: '4c8f0a52-9a0e-4d1c-b8f5-1a2b3c4d5e6f',
    projectKey: 'tenant-a',
    cwd,
    prompt: 'Greet, read a.md, edit it and run a command.',
    engine: 'mastra',
    portable: {
      name: 'Helper',
      instructions: 'Be terse.',
      model: 'claude-sonnet-4-5',
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: false,
      },
      skills: { mode: 'allowlist', names: ['greeter'] },
      mcpServers: {},
      limits: { maxTurns: null, maxBudgetUsd: null },
    },
    policy: {},
    session: { mode: 'fresh' },
    gateway: { baseUrl: GATEWAY, token: TOKEN, protocol: 'anthropic-messages' },
    resources: { files: [], skills: [{ name: 'greeter', files: [] }] },
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: cwd },
    ...overrides,
  };
}

export async function drain(frames: AsyncIterable<EngineFrame>): Promise<EngineFrame[]> {
  const out: EngineFrame[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

export function neutral(frames: readonly EngineFrame[]): string[] {
  return frames.filter((frame) => frame.frame !== 'agent.native').map((frame) => frame.frame);
}

/** A read-only subagent on the parent's model. */
export const RESEARCHER = {
  name: 'researcher',
  description: 'Reads files and reports.',
  instructions: 'You only research.',
  model: null,
  permissions: {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  },
};

// Importing Mastra (and the MCP client) is a one-off cost of seconds on a cold or loaded machine.
// Pay it here, under the hook's own limit, so no scenario's 5 s budget is spent on module loading
// and every test measures only its own run.
beforeAll(async () => {
  await preloadMastra();
}, 120_000);

beforeEach(() => {
  scriptedGateway.seen.length = 0;
  scriptedGateway.script = [];
  globalThis.fetch = gatewayFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A minimal MCP server over stdio: newline-delimited JSON-RPC, one tool, `echo`. It answers the
 * protocol version the client asks for and refuses every method it does not implement by name.
 */
export const ECHO_MCP_SERVER = `
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } });
  } else if (message.method === 'tools/list') {
    send({ id: message.id, result: { tools: [{ name: 'echo', description: 'Echo text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  } else if (message.method === 'tools/call') {
    send({ id: message.id, result: { content: [{ type: 'text', text: 'echo: ' + message.params.arguments.text }] } });
  } else if (message.method === 'ping') {
    send({ id: message.id, result: {} });
  } else {
    send({ id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } });
  }
});
`;
