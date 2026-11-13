import {
  A2aJsonRpcResponseSchema,
  A2aTaskSchema,
  type A2aTask,
} from '@indx-workspace/contracts/a2a';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import {
  type AgentRef,
  type LaunchContext,
  type RunPrincipal,
  type RunApiEnvironment,
  type SessionRef,
} from '../runs/environment';
import { InMemoryRunStore } from '../runs/memory-store';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { resolveAgentRunOwnership } from '../agents/run-ownership';
import { applicationContext, clearApplicationContext } from '../application-context';
import {
  installTestDomains,
  installTestRunApi,
  resetTestRunApi,
} from '../application-context-fixtures';
import type { A2aCredentialVia, A2aEnvironment, A2aIdentity } from './env';
import { resetA2aLimits } from './limits';

export const WORKSPACE = '22222222-2222-4222-8222-222222222222';

export const OTHER_WORKSPACE = '55555555-5555-4555-8555-555555555555';

export const AGENT = '33333333-3333-4333-8333-333333333333';

export const OTHER_AGENT = '99999999-9999-4999-8999-999999999999';

export const SESSION = '44444444-4444-4444-8444-444444444444';

export const PRODUCTION_VERSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const KEY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const SECRET = 'ak_live_SECRETSECRETSECRETSECRETSECRET00';

export function installA2a(environment: A2aEnvironment): void {
  installTestDomains({
    a2a: { kind: 'serving', environment },
    // The run-ownership check reads the agents runtime; an empty store answers `unknown`, as the
    // unwired agents slot did before it moved into the application context.
    agents: {
      agents: createInMemoryAgentStoreProvider(),
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
    },
  });
}

export function installedA2a(): A2aEnvironment | null {
  const a2a = applicationContext()?.a2a;
  return a2a?.kind === 'serving' ? a2a.environment : null;
}

export const URL_BASE = 'http://web/api/a2a/agents';

export function principal(overrides: Partial<RunPrincipal> = {}): RunPrincipal {
  return {
    principalId: '77777777-7777-4777-8777-777777777777',
    ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
    userId: null,
    workspaceId: WORKSPACE,
    role: 'owner',
    scope: null,
    ...overrides,
  };
}

export const OAUTH_CLIENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

export const oauthIdentity = (audience: string) => ({
  via: 'oauth-token' as const,
  principal: principal({ scope: { kind: 'a2a-agent', id: AGENT } }),
  keyId: null,
  audience,
});

export const IDENTITIES: Readonly<
  Record<
    string,
    { via: A2aCredentialVia; principal: RunPrincipal; keyId: string | null; audience?: string }
  >
> = {
  oauth: oauthIdentity('https://aw.example/api/a2a/agents/support-bot'),
  oauthOtherAgent: oauthIdentity('https://aw.example/api/a2a/agents/billing-bot'),
  oauthMcp: oauthIdentity('https://aw.example/mcp/projects/support-bot'),
  oauthBuilder: {
    ...oauthIdentity('https://aw.example/mcp/builder'),
    principal: principal({ scope: { kind: 'builder', id: OAUTH_CLIENT } }),
  },
  owner: { via: 'api-key', principal: principal(), keyId: KEY_ID },
  second: { via: 'api-key', principal: principal(), keyId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
  viewer: { via: 'api-key', principal: principal({ role: 'viewer' }), keyId: KEY_ID },
  scoped: {
    via: 'api-key',
    principal: principal({ scope: { kind: 'a2a-agent', id: AGENT } }),
    keyId: KEY_ID,
  },
  scopedElsewhere: {
    via: 'api-key',
    principal: principal({ scope: { kind: 'a2a-agent', id: OTHER_AGENT } }),
    keyId: KEY_ID,
  },
  mcpKey: {
    via: 'api-key',
    principal: principal({
      scope: { kind: 'mcp-project', id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
    }),
    keyId: KEY_ID,
  },
  otherTenant: {
    via: 'api-key',
    principal: principal({ workspaceId: OTHER_WORKSPACE }),
    keyId: KEY_ID,
  },
  session: { via: 'session', principal: principal(), keyId: null },
  browserToken: { via: 'browser-token', principal: principal(), keyId: KEY_ID },
  userToken: { via: 'user-token', principal: principal(), keyId: null },
};

export interface Scenario {
  /** What the launched run says, one `agent.message` per entry. */
  chunks: string[];
  outcome: 'completed' | 'failed' | 'hang';
}

export interface DispatchState {
  store: InMemoryRunStore;
  launched: LaunchContext[];
  scenario: Scenario;
  foreignRuns: Set<string>;
  openedVersions: Array<string | undefined>;
  openSessionFails: boolean;
  interrupted: string[];
}

export const state: DispatchState = {
  store: new InMemoryRunStore(),
  launched: [],
  scenario: { chunks: [], outcome: 'completed' },
  foreignRuns: new Set(),
  openedVersions: [],
  openSessionFails: false,
  interrupted: [],
};

export function frame(text: string): unknown {
  return {
    frame: 'agent.message',
    engine: 'claude-agent-sdk',
    raw: null,
    messageId: null,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
  };
}

export function installAll(): void {
  const environment: RunApiEnvironment = {
    authenticate: () => Promise.resolve(null),
    findAgent: (p: RunPrincipal, agentId: string): Promise<AgentRef | null> =>
      Promise.resolve(
        agentId === AGENT
          ? { id: AGENT, workspaceId: p.workspaceId, engine: 'claude-agent-sdk' }
          : null,
      ),
    openSession: (
      _p: RunPrincipal,
      agent: AgentRef,
      requested: string | null,
      agentVersionId?: string,
    ): Promise<SessionRef | null> => {
      if (state.openSessionFails) {
        return Promise.reject(new Error('connect ECONNREFUSED postgres://aw:hunter2@db:5432/aw'));
      }
      state.openedVersions.push(agentVersionId);
      return Promise.resolve(
        requested === null || requested === SESSION
          ? { id: SESSION, agentId: agent.id, engine: null }
          : null,
      );
    },
    ownsRun: (_p, run) => Promise.resolve(!state.foreignRuns.has(run.id)),
    store: state.store,
    launch: (context: LaunchContext): void => {
      state.launched.push(context);
      const { id } = context.run;
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await state.store.markRunning(id);
        for (const text of state.scenario.chunks) {
          await state.store.append(id, { type: 'agent.message', data: frame(text) });
        }
        if (state.scenario.outcome === 'hang') return;
        await state.store.finish(
          id,
          state.scenario.outcome,
          state.scenario.outcome === 'failed' ? 'the engine stopped' : null,
          true,
        );
      })();
    },
    interruptRun: async (_p, run) => {
      state.interrupted.push(run.id);
      await state.store.finish(run.id, 'cancelled', 'the run was interrupted by request', true);
    },
  };
  installTestRunApi(environment);
  installA2a({
    // The production rule over the installed agents runtime, as the composition root wires it.
    agentOwnership: resolveAgentRunOwnership,
    identify: (request): Promise<A2aIdentity | null> => {
      const named = IDENTITIES[request.headers.get('x-test-identity') ?? ''];
      return Promise.resolve(
        named === undefined
          ? null
          : {
              principal: named.principal,
              via: named.via,
              apiKeyId: named.keyId,
              oauth:
                named.audience === undefined
                  ? null
                  : { clientId: OAUTH_CLIENT, audience: named.audience },
            },
      );
    },
    findPublishedAgent: (workspaceId, name) =>
      Promise.resolve(
        workspaceId === WORKSPACE && name === 'support-bot'
          ? { agentId: AGENT, name, productionVersionId: PRODUCTION_VERSION, versionNumber: 7 }
          : null,
      ),
    findDeploymentAgent: (name) =>
      Promise.resolve(
        name === 'support-bot'
          ? { agentId: AGENT, name, productionVersionId: PRODUCTION_VERSION, versionNumber: 7 }
          : null,
      ),
    now: () => Date.now(),
  });
}

export function rpc(
  method: string,
  params: unknown,
  options: {
    identity?: string;
    agent?: string;
    headers?: Record<string, string>;
    url?: string;
  } = {},
): Request {
  return new Request(options.url ?? `${URL_BASE}/${options.agent ?? 'support-bot'}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SECRET}`,
      'x-test-identity': options.identity ?? 'owner',
      ...options.headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

export const send = (
  text: string,
  extra: Record<string, unknown> = {},
  configuration?: unknown,
  identity?: string,
) =>
  rpc(
    'message/send',
    {
      message: {
        kind: 'message',
        messageId: 'm1',
        role: 'user',
        parts: [{ kind: 'text', text }],
        ...extra,
      },
      ...(configuration === undefined ? {} : { configuration }),
    },
    identity === undefined ? {} : { identity },
  );

export interface RpcBody {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
  readonly id: unknown;
}

export async function body(response: Response): Promise<RpcBody> {
  return A2aJsonRpcResponseSchema.parse(await response.json());
}

export async function task(response: Response): Promise<A2aTask> {
  const parsed = await body(response);
  expect(parsed.error).toBeUndefined();
  return A2aTaskSchema.parse(parsed.result);
}

export async function errorCodeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

export async function frames(
  response: Response,
): Promise<Array<{ result?: Record<string, unknown>; error?: { code: number } }>> {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as never);
}

beforeEach(() => {
  state.store = new InMemoryRunStore();
  state.launched = [];
  state.scenario = { chunks: ['Hello from the agent.'], outcome: 'completed' };
  state.foreignRuns = new Set();
  state.openedVersions = [];
  state.openSessionFails = false;
  state.interrupted = [];
  resetA2aLimits();
  installAll();
});

afterEach(() => {
  clearApplicationContext();
  resetTestRunApi();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
