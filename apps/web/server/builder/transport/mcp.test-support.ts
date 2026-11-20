import { createRunTokenCodec } from '@agent-workspace/gateway/tokens';
import { afterEach, vi } from 'vitest';

import type { RunTokenDatabase } from '../../gateway/run-token-verifier';
import type { DirectoryRoot } from '../../rbac/directory';
import { callContextOf } from '../testing/context';
import { makeMemoryPorts } from '../testing/ports';
import type { CallContext } from '../ports';
import type { BuilderPorts } from '../tools/types';
import type { BuilderRunReader } from './call-context';
import { createBuilderCallerVerifier, type BuilderCallerVerifier, type BuilderDoor } from './mcp';
import { resetBuilderDoorLimits } from './limits';

export const RUN_IDENTITY = {
  kind: 'run',
  workspaceId: 'ws-secret-id',
  runId: 'run-secret-id',
  sessionId: 'session-1',
  agentId: 'agent-1',
} as const;

export const CALLER = {
  ok: true,
  caller: {
    ...RUN_IDENTITY,
    kind: 'run-caller',
    principalId: 'principal-secret-sub',
    userId: 'user-1',
    role: 'builder',
  },
} as const;

export const allow: BuilderCallerVerifier = () => Promise.resolve(CALLER);
export const readOnly: BuilderCallerVerifier = () =>
  Promise.resolve({ ok: false, code: 'no_caller', reads: true, run: RUN_IDENTITY });
export const refuse: BuilderCallerVerifier = () =>
  Promise.resolve({ ok: false, code: 'not_permitted', reads: false });

export function rpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/builder/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token', ...headers },
    body: JSON.stringify(body),
  });
}

export const call = (method: string, params?: unknown): unknown => ({
  jsonrpc: '2.0',
  id: 7,
  method,
  ...(params === undefined ? {} : { params }),
});

/** Reset mocks and the door's rate-limit counters after every test of the calling file. */
export function resetDoorAfterEach(): void {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetBuilderDoorLimits();
  });
}

export const readRun = vi.fn<BuilderRunReader>(() =>
  Promise.resolve({
    modelId: 'model-1',
    agentVersion: { id: 'version-1', number: 1, summary: 'v1' },
  }),
);

/** The door with no ports (every call `builder_disabled`) unless a test gives some. */
export const door = (
  verifyCaller: BuilderCallerVerifier,
  more: Partial<BuilderDoor> = {},
): BuilderDoor => ({
  verifyCaller,
  ports: null,
  readRun,
  ...more,
});

/** Memory ports, switched on, whose every method call is recorded in `reached` as (port, method, ...args). */
export function spyPorts() {
  const inner = makeMemoryPorts();
  const reached = vi.fn<(port: string, method: string, ...args: unknown[]) => void>();
  const wrap = (name: string, port: object) =>
    new Proxy(port, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          reached(name, String(key), ...args);
          const result: unknown = Reflect.apply(value, target, args);
          return result;
        };
      },
    });
  const ports = Object.fromEntries(
    Object.entries(inner).map(([name, port]) => [name, wrap(name, port)]),
  ) as unknown as BuilderPorts;
  // The journal of the run the test tokens name.
  const ctx = { ...callContextOf(RUN_IDENTITY.workspaceId, 'builder'), runId: RUN_IDENTITY.runId };
  const journalled = async () => (await inner.audit.runCounts(ctx)).toolCalls;
  return { ports, reached, journalled };
}

/** The ctx the shell handed the ports, read off the first port call. */
export function ctxOf(reached: ReturnType<typeof spyPorts>['reached']): CallContext {
  return reached.mock.calls[0]?.[2] as CallContext;
}

export async function toolAnswer(response: Response) {
  const text = await response.text();
  const body = JSON.parse(text) as {
    result: { isError: boolean; content: Array<{ type: string; text: string }> };
  };
  const [content] = body.result.content;
  return {
    text,
    isError: body.result.isError,
    result: JSON.parse(content?.text ?? 'null') as unknown,
  };
}

/** The ids of every call the audit port was asked to record, in order. */
export const recordedIds = (reached: ReturnType<typeof spyPorts>['reached']) =>
  reached.mock.calls
    .filter(([port, method]) => port === 'audit' && method === 'record')
    .map((args) => (args[3] as { callId: string }).callId);

/** Spies on every console channel, so a test can assert nothing was logged. */
export const spyOnConsole = () =>
  (['log', 'error', 'warn', 'info'] as const).map((level) => vi.spyOn(console, level));

/** A real verifier that throws if it ever reads anything behind a token that does not verify. */
export function unreadableVerifier(): BuilderCallerVerifier {
  const database = new Proxy({} as RunTokenDatabase, {
    get() {
      throw new Error('the database must not be read for a token that does not verify');
    },
  });
  const directory = {
    forWorkspace() {
      throw new Error('the directory must not be read for a token that does not verify');
    },
  } as unknown as DirectoryRoot;
  return createBuilderCallerVerifier({
    tokens: createRunTokenCodec({ secret: 'mcp-door-test-secret-at-least-thirty-two-bytes' }),
    database,
    directory,
    agents: {
      forWorkspace() {
        throw new Error('the agents must not be read for a token that does not verify');
      },
    },
    ceiling: null,
  });
}
