/** A fake Anthropic Messages gateway and the run helpers the pi boundary suites share. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { EngineFrame, EngineRunRequest, EngineSessionStore } from '@agent-workspace/engine';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';

import { createPiEngine } from './engine.js';

export const TOKEN = 'run-token-for-the-fake-gateway';
export const SESSION_ID = '5b0c1f7e-8d2a-4c3b-9e1f-2a3b4c5d6e7f';

export type Recorded = {
  readonly path: string;
  readonly authorization: string | null;
  readonly apiKeyHeader: string | null;
  readonly body: Record<string, unknown>;
};

/** One scripted model turn. */
type Turn = (
  | { readonly call: { readonly name: string; readonly args: Record<string, unknown> } }
  | { readonly text: string }
) & {
  /** Prompt-cache write tokens the response reports (`cache_creation_input_tokens`). */
  readonly cacheWrite?: number;
};

function sse(events: readonly Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

function messagesStream(turn: Turn, index: number): string {
  const start = {
    type: 'message_start',
    message: {
      id: `msg_${String(index)}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        ...(turn.cacheWrite === undefined ? {} : { cache_creation_input_tokens: turn.cacheWrite }),
      },
    },
  };
  const block =
    'call' in turn
      ? [
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
        ]
      : [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } },
        ];
  return sse([
    start,
    ...block,
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'call' in turn ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: 5 },
    },
    { type: 'message_stop' },
  ]);
}

/** A scripted refusal: the provider (or the gateway, with a `token_*` code) answers with a status. */
type Refusal = { readonly refuse: { readonly status: number; readonly code?: string } };

type Gateway = {
  readonly baseUrl: string;
  readonly requests: Recorded[];
  script(turns: readonly (Turn | Refusal)[]): void;
  close(): Promise<void>;
};

async function startGateway(): Promise<Gateway> {
  const requests: Recorded[] = [];
  let turns: readonly (Turn | Refusal)[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    request.on('end', () => {
      const index = requests.length;
      requests.push({
        path: new URL(request.url ?? '/', 'http://gateway.test').pathname,
        authorization: request.headers.authorization ?? null,
        apiKeyHeader: (request.headers['x-api-key'] as string | undefined) ?? null,
        body: JSON.parse(raw) as Record<string, unknown>,
      });
      const turn = turns[index] ?? { text: 'Done.' };
      if ('refuse' in turn) {
        response.writeHead(turn.refuse.status, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'refused', code: turn.refuse.code },
          }),
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(messagesStream(turn, index));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    requests,
    script(next) {
      turns = next;
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type FakeGateways = {
  readonly gateway: Gateway;
  readonly decoy: Gateway;
  readonly root: string;
  workspace(): string;
  baseRequest(cwd: string, overrides?: Partial<EngineRunRequest>): EngineRunRequest;
};

/** Starts a gateway and a decoy for the suite, with a scratch root, and tears them down after. */
export function useFakeGateways(): FakeGateways {
  const state = {} as { gateway: Gateway; decoy: Gateway; root: string };
  let workspaceCount = 0;

  beforeAll(async () => {
    state.gateway = await startGateway();
    state.decoy = await startGateway();
    state.root = mkdtempSync(path.join(tmpdir(), 'engine-pi-'));
  });

  afterAll(async () => {
    await state.gateway.close();
    await state.decoy.close();
    rmSync(state.root, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  return {
    get gateway() {
      return state.gateway;
    },
    get decoy() {
      return state.decoy;
    },
    get root() {
      return state.root;
    },
    workspace() {
      workspaceCount += 1;
      const cwd = path.join(state.root, `ws-${String(workspaceCount)}`);
      mkdirSync(cwd, { recursive: true });
      return cwd;
    },
    baseRequest: (cwd, overrides = {}) => piRequest(state.gateway.baseUrl, cwd, overrides),
  };
}

function piRequest(
  gatewayUrl: string,
  cwd: string,
  overrides: Partial<EngineRunRequest>,
): EngineRunRequest {
  return {
    runId: 'b6f1c2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    sessionId: SESSION_ID,
    projectKey: 'pi-tenant',
    cwd,
    prompt: 'Read a.md and write b.md.',
    engine: 'pi',
    portable: {
      name: 'pi agent',
      instructions: 'PLATFORM INSTRUCTIONS: be terse.',
      model: 'claude-sonnet-4-5',
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: false,
      },
      skills: { mode: 'allowlist', names: [] },
      mcpServers: {},
      limits: { maxTurns: null, maxBudgetUsd: null },
    },
    policy: {},
    session: { mode: 'fresh' },
    gateway: { baseUrl: gatewayUrl, token: TOKEN, protocol: 'anthropic-messages' },
    resources: { files: [], skills: [] },
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: cwd },
    ...overrides,
  };
}

export async function run(
  request: EngineRunRequest,
  store?: EngineSessionStore,
  onFrame?: (frame: EngineFrame, interrupt: () => Promise<void>) => void,
): Promise<EngineFrame[]> {
  const connection = createPiEngine().start(
    request,
    store === undefined ? {} : { sessionStore: store },
  );
  const frames: EngineFrame[] = [];
  for await (const frame of connection.frames) {
    frames.push(frame);
    onFrame?.(frame, () => connection.interrupt());
  }
  return frames;
}

export function systemText(recorded: Recorded): string {
  return JSON.stringify(recorded.body['system'] ?? '');
}

export function toolNames(recorded: Recorded): string[] {
  const tools = recorded.body['tools'];
  return Array.isArray(tools)
    ? tools.map((tool) => String((tool as Record<string, unknown>)['name']))
    : [];
}

export function result(frames: readonly EngineFrame[]): EngineFrame | undefined {
  return frames.find((frame) => frame.frame === 'agent.result');
}
