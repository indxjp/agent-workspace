import { captureLog } from '../telemetry/capture-log';
import {
  A2aAgentCardSchema,
  A2aJsonRpcResponseSchema,
  A2aTaskSchema,
  A2A_ERROR_CODES,
  type A2aTask,
} from '@indx-workspace/contracts/a2a';
import { RUN_STATUSES } from '@indx-workspace/contracts/runs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getRunApi,
  type AgentRef,
  type LaunchContext,
  type RunPrincipal,
  type RunApiEnvironment,
  type SessionRef,
} from '../runs/environment';
import { InMemoryRunStore } from '../runs/memory-store';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { A2A_MAX_BODY_BYTES, serveA2aCard, serveA2aRpc } from './dispatch';
import { applicationContext, clearApplicationContext } from '../application-context';
import {
  installTestDomains,
  installTestRunApi,
  resetTestRunApi,
} from '../application-context-fixtures';
import type { A2aCredentialVia, A2aEnvironment, A2aIdentity } from './env';
import { A2A_RATE_LIMITS, resetA2aLimits } from './limits';
import { taskState } from './v0_3/map';
import { handleV03, type A2aCall } from './v0_3/rpc';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const OTHER_WORKSPACE = '55555555-5555-4555-8555-555555555555';
const AGENT = '33333333-3333-4333-8333-333333333333';
const OTHER_AGENT = '99999999-9999-4999-8999-999999999999';
const SESSION = '44444444-4444-4444-8444-444444444444';
const PRODUCTION_VERSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECRET = 'ak_live_SECRETSECRETSECRETSECRETSECRET00';
function installA2a(environment: A2aEnvironment): void {
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

function installedA2a(): A2aEnvironment | null {
  const a2a = applicationContext()?.a2a;
  return a2a?.kind === 'serving' ? a2a.environment : null;
}

const URL_BASE = 'http://web/api/a2a/agents';

function principal(overrides: Partial<RunPrincipal> = {}): RunPrincipal {
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

/** Who `x-test-identity` names; the real bearer on the request is only ever a secret to leak. */
const OAUTH_CLIENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const oauthIdentity = (audience: string) => ({
  via: 'oauth-token' as const,
  principal: principal({ scope: { kind: 'a2a-agent', id: AGENT } }),
  keyId: null,
  audience,
});

const IDENTITIES: Readonly<
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

interface Scenario {
  /** What the launched run says, one `agent.message` per entry. */
  chunks: string[];
  outcome: 'completed' | 'failed' | 'hang';
}

let store: InMemoryRunStore;
let launched: LaunchContext[];
let scenario: Scenario;
let foreignRuns: Set<string>;
let openedVersions: Array<string | undefined>;
let openSessionFails: boolean;
let interrupted: string[];

function frame(text: string): unknown {
  return {
    frame: 'agent.message',
    engine: 'claude-agent-sdk',
    raw: null,
    messageId: null,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
  };
}

function installAll(): void {
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
      if (openSessionFails) {
        return Promise.reject(new Error('connect ECONNREFUSED postgres://aw:hunter2@db:5432/aw'));
      }
      openedVersions.push(agentVersionId);
      return Promise.resolve(
        requested === null || requested === SESSION
          ? { id: SESSION, agentId: agent.id, engine: null }
          : null,
      );
    },
    ownsRun: (_p, run) => Promise.resolve(!foreignRuns.has(run.id)),
    store,
    launch: (context: LaunchContext): void => {
      launched.push(context);
      const { id } = context.run;
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await store.markRunning(id);
        for (const text of scenario.chunks) {
          await store.append(id, { type: 'agent.message', data: frame(text) });
        }
        if (scenario.outcome === 'hang') return;
        await store.finish(
          id,
          scenario.outcome,
          scenario.outcome === 'failed' ? 'the engine stopped' : null,
          true,
        );
      })();
    },
    interruptRun: async (_p, run) => {
      interrupted.push(run.id);
      await store.finish(run.id, 'cancelled', 'the run was interrupted by request', true);
    },
  };
  installTestRunApi(environment);
  installA2a({
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

function rpc(
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

const send = (
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

interface RpcBody {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
  readonly id: unknown;
}

async function body(response: Response): Promise<RpcBody> {
  return A2aJsonRpcResponseSchema.parse(await response.json());
}

async function task(response: Response): Promise<A2aTask> {
  const parsed = await body(response);
  expect(parsed.error).toBeUndefined();
  return A2aTaskSchema.parse(parsed.result);
}

async function errorCodeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

async function frames(
  response: Response,
): Promise<Array<{ result?: Record<string, unknown>; error?: { code: number } }>> {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as never);
}

beforeEach(() => {
  store = new InMemoryRunStore();
  launched = [];
  scenario = { chunks: ['Hello from the agent.'], outcome: 'completed' };
  foreignRuns = new Set();
  openedVersions = [];
  openSessionFails = false;
  interrupted = [];
  resetA2aLimits();
  installAll();
});

afterEach(() => {
  clearApplicationContext();
  resetTestRunApi();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('who may call the A2A endpoint', () => {
  it('answers 401 with a Bearer challenge when no credential identifies the caller', async () => {
    const response = await serveA2aRpc(
      rpc('tasks/get', { id: 'x' }, { identity: 'nobody' }),
      'support-bot',
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="agent-workspace"');
  });

  it.each(['session', 'browserToken', 'userToken'])(
    'refuses a %s credential with 403 a2a_credential_not_accepted',
    async (identity) => {
      const refused = await serveA2aRpc(rpc('message/send', {}, { identity }), 'support-bot');
      expect(refused.status).toBe(403);
      expect(await errorCodeOf(refused)).toBe('a2a_credential_not_accepted');
      expect(launched).toHaveLength(0);
    },
  );

  it('refuses a request that carries an Origin header, however well authenticated', async () => {
    const refused = await serveA2aRpc(
      rpc('tasks/get', { id: AGENT }, { headers: { Origin: 'https://evil.example' } }),
      'support-bot',
    );
    expect(refused.status).toBe(403);
    expect(await errorCodeOf(refused)).toBe('origin_not_allowed');
  });

  it('keeps tenants apart: another workspace, an unknown name and an unpublished agent look the same', async () => {
    const foreign = await serveA2aRpc(
      rpc('tasks/get', { id: AGENT }, { identity: 'otherTenant' }),
      'support-bot',
    );
    const unknown = await serveA2aRpc(rpc('tasks/get', { id: AGENT }), 'no-such-agent');
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.text()).toBe(await unknown.text());
    expect(launched).toHaveLength(0);
  });

  it('keeps an agent whose run lookup fails out of reach with the same 404', async () => {
    installTestRunApi({
      authenticate: () => Promise.resolve(null),
      findAgent: () => Promise.resolve(null),
      openSession: () => Promise.resolve(null),
      ownsRun: () => Promise.resolve(true),
      store,
      launch: () => undefined,
    });
    const response = await serveA2aRpc(rpc('tasks/get', { id: AGENT }), 'support-bot');
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe('a2a_agent_not_found');
  });

  it('admits a key scoped to this agent and answers one scoped to another with the unknown-name 404', async () => {
    const scoped = await serveA2aRpc(
      rpc(
        'message/send',
        {
          message: {
            kind: 'message',
            messageId: 'm',
            role: 'user',
            parts: [{ kind: 'text', text: 'hi' }],
          },
          configuration: { blocking: false },
        },
        { identity: 'scoped' },
      ),
      'support-bot',
    );
    expect(scoped.status).toBe(200);
    expect((await task(scoped)).status.state).toBe('submitted');
    const elsewhere = await serveA2aRpc(
      rpc(
        'message/send',
        {
          message: {
            kind: 'message',
            messageId: 'm',
            role: 'user',
            parts: [{ kind: 'text', text: 'hi' }],
          },
        },
        { identity: 'scopedElsewhere' },
      ),
      'support-bot',
    );
    expect(elsewhere.status).toBe(404);
    expect(await errorCodeOf(elsewhere.clone())).toBe('a2a_agent_not_found');
    const unknown = await serveA2aRpc(rpc('tasks/get', { id: AGENT }), 'no-such-agent');
    expect(await elsewhere.text()).toBe(await unknown.text());
  });

  it('answers an mcp-project key with the unknown-name 404, launching nothing', async () => {
    const response = await serveA2aRpc(
      send('hi', {}, { blocking: false }, 'mcpKey'),
      'support-bot',
    );
    expect(response.status).toBe(404);
    expect(await errorCodeOf(response)).toBe('a2a_agent_not_found');
    expect(launched).toHaveLength(0);
  });

  it('refuses a viewer, who may not run the agent, with 403 before any run exists', async () => {
    const response = await serveA2aRpc(
      rpc(
        'message/send',
        {
          message: {
            kind: 'message',
            messageId: 'm',
            role: 'user',
            parts: [{ kind: 'text', text: 'hi' }],
          },
        },
        { identity: 'viewer' },
      ),
      'support-bot',
    );
    expect(response.status).toBe(403);
    expect(launched).toHaveLength(0);
  });

  it('refuses an unsupported A2A-Version header or query parameter with 400', async () => {
    for (const request of [
      rpc('tasks/get', { id: 'x' }, { headers: { 'A2A-Version': '1.0' } }),
      rpc('tasks/get', { id: 'x' }, { url: `${URL_BASE}/support-bot?A2A-Version=0.4` }),
    ]) {
      const response = await serveA2aRpc(request, 'support-bot');
      expect(response.status).toBe(400);
      expect(await errorCodeOf(response)).toBe('a2a_version_unsupported');
    }
  });

  it.each(['', '0.3', '0.3.0'])('serves A2A-Version %j as v0.3', async (version) => {
    const response = await serveA2aRpc(
      rpc('tasks/get', { id: 'not-a-uuid' }, { headers: { 'A2A-Version': version } }),
      'support-bot',
    );
    expect(response.status).toBe(200);
    expect((await body(response)).error?.code).toBe(A2A_ERROR_CODES.task_not_found);
  });

  it('serves a client that names no version at all', async () => {
    const response = await serveA2aRpc(rpc('tasks/get', { id: 'x' }), 'support-bot');
    expect((await body(response)).error?.code).toBe(A2A_ERROR_CODES.task_not_found);
  });
});

describe('OAuth access tokens on the A2A endpoint (ADR-0134 part 3)', () => {
  beforeEach(() => {
    vi.stubEnv('AW_PUBLIC_URL', 'https://aw.example');
  });

  it('serves a token issued for this agent', async () => {
    const response = await serveA2aRpc(send('hi', {}, { blocking: false }, 'oauth'), 'support-bot');
    expect(response.status).toBe(200);
    expect((await task(response)).status.state).toBe('submitted');
  });

  it.each(['oauthOtherAgent', 'oauthMcp', 'oauthBuilder'])(
    'refuses a token issued for another URL (%s) with 401 invalid_token and a challenge, starting no run',
    async (identity) => {
      const response = await serveA2aRpc(
        send('hi', {}, { blocking: false }, identity),
        'support-bot',
      );
      expect(response.status).toBe(401);
      expect(await errorCodeOf(response)).toBe('invalid_token');
      const challenge = response.headers.get('WWW-Authenticate') ?? '';
      expect(challenge).toContain('error="invalid_token"');
      expect(challenge).toContain(
        'resource_metadata="https://aw.example/.well-known/oauth-protected-resource/api/a2a/agents/support-bot"',
      );
      expect(launched).toHaveLength(0);
    },
  );

  it('refuses the same token on the agent card', async () => {
    const response = await serveA2aCard(
      new Request(`${URL_BASE}/support-bot/.well-known/agent-card.json`, {
        headers: { 'x-test-identity': 'oauthMcp', Authorization: `Bearer ${SECRET}` },
      }),
      'support-bot',
    );
    expect(response.status).toBe(401);
  });

  it('points an unauthenticated caller at the protected-resource metadata', async () => {
    const response = await serveA2aRpc(
      rpc('tasks/get', { id: 'x' }, { identity: 'nobody' }),
      'support-bot',
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="agent-workspace", resource_metadata="https://aw.example/.well-known/oauth-protected-resource/api/a2a/agents/support-bot"',
    );
  });
});

describe('the rate limits on the public A2A route', () => {
  it('answers 429 a2a_rate_limited with Retry-After once a credential spends its calls', async () => {
    for (let call = 0; call < A2A_RATE_LIMITS.callsPerMinute; call += 1) {
      const response = await serveA2aRpc(rpc('tasks/get', { id: 'x' }), 'support-bot');
      expect(response.status).toBe(200);
    }
    const limited = await serveA2aRpc(rpc('tasks/get', { id: 'x' }), 'support-bot');
    expect(limited.status).toBe(429);
    expect(await errorCodeOf(limited)).toBe('a2a_rate_limited');
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    const other = await serveA2aRpc(
      rpc('tasks/get', { id: 'x' }, { identity: 'second' }),
      'support-bot',
    );
    expect(other.status).toBe(200);
  });

  it('limits the calls that start a run more tightly, and leaves reads unlimited by it', async () => {
    for (let call = 0; call < A2A_RATE_LIMITS.messagesPerMinute; call += 1) {
      const response = await serveA2aRpc(send('hi', {}, { blocking: false }), 'support-bot');
      expect((await body(response)).error).toBeUndefined();
    }
    const limited = await serveA2aRpc(send('hi', {}, { blocking: false }), 'support-bot');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).not.toBeNull();
    expect(launched).toHaveLength(A2A_RATE_LIMITS.messagesPerMinute);
    const read = await serveA2aRpc(rpc('tasks/get', { id: 'x' }), 'support-bot');
    expect(read.status).toBe(200);
  });

  it('counts the 404 answers against the limit, so agent names cannot be probed for free', async () => {
    for (const [identity, agent, status] of [
      ['owner', 'no-such-agent', 404],
      ['scopedElsewhere', 'support-bot', 404],
    ] as const) {
      resetA2aLimits();
      for (let call = 0; call < A2A_RATE_LIMITS.callsPerMinute; call += 1) {
        const refused = await serveA2aRpc(
          rpc('tasks/get', { id: 'x' }, { identity, agent }),
          agent,
        );
        expect(refused.status).toBe(status);
      }
      const limited = await serveA2aRpc(rpc('tasks/get', { id: 'x' }, { identity, agent }), agent);
      expect(limited.status).toBe(429);
      expect(await errorCodeOf(limited)).toBe('a2a_rate_limited');
    }
  });

  it('refuses an over-limit call before looking the agent up', async () => {
    const a2a = installedA2a();
    if (a2a === null) throw new Error('A2A not installed');
    const findPublishedAgent = vi.fn((workspaceId: string, name: string) =>
      a2a.findPublishedAgent(workspaceId, name),
    );
    installA2a({ ...a2a, findPublishedAgent });
    for (let call = 0; call < A2A_RATE_LIMITS.callsPerMinute; call += 1) {
      await serveA2aRpc(rpc('tasks/get', { id: 'x' }), 'support-bot');
    }
    expect(findPublishedAgent).toHaveBeenCalledTimes(A2A_RATE_LIMITS.callsPerMinute);
    findPublishedAgent.mockClear();
    const limited = await serveA2aRpc(rpc('tasks/get', { id: 'x' }), 'support-bot');
    expect(limited.status).toBe(429);
    expect(findPublishedAgent).not.toHaveBeenCalled();
  });

  it('limits the agent card the same way', async () => {
    for (let call = 0; call < A2A_RATE_LIMITS.callsPerMinute; call += 1) {
      await serveA2aCard(rpc('x', {}), 'support-bot');
    }
    const limited = await serveA2aCard(rpc('x', {}), 'support-bot');
    expect(limited.status).toBe(429);
  });
});

describe('the JSON-RPC envelope', () => {
  const raw = (text: string) =>
    new Request(`${URL_BASE}/support-bot`, {
      method: 'POST',
      headers: { 'x-test-identity': 'owner', Authorization: `Bearer ${SECRET}` },
      body: text,
    });

  it('answers a body past the cap 413 a2a_body_too_large without parsing it', async () => {
    const response = await serveA2aRpc(raw('a'.repeat(A2A_MAX_BODY_BYTES + 1)), 'support-bot');
    expect(response.status).toBe(413);
    expect(await errorCodeOf(response)).toBe('a2a_body_too_large');
  });

  it('maps malformed input to the JSON-RPC codes, all with HTTP 200', async () => {
    const cases: Array<[string, number]> = [
      ['{not json', A2A_ERROR_CODES.parse_error],
      ['[{"jsonrpc":"2.0","id":1,"method":"tasks/get"}]', A2A_ERROR_CODES.invalid_request],
      ['{"jsonrpc":"1.0","id":1,"method":"tasks/get"}', A2A_ERROR_CODES.invalid_request],
      ['{"jsonrpc":"2.0","id":1,"method":"nope/nothing"}', A2A_ERROR_CODES.method_not_found],
      ['{"jsonrpc":"2.0","id":1,"method":"tasks/get","params":{}}', A2A_ERROR_CODES.invalid_params],
      [
        '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{}}}',
        A2A_ERROR_CODES.invalid_params,
      ],
    ];
    for (const [text, code] of cases) {
      const response = await serveA2aRpc(raw(text), 'support-bot');
      expect(response.status, text).toBe(200);
      expect((await body(response)).error?.code, text).toBe(code);
    }
  });

  it('answers the methods it does not offer with the codes the protocol assigns', async () => {
    const resubscribe = await serveA2aRpc(rpc('tasks/resubscribe', { id: AGENT }), 'support-bot');
    expect((await body(resubscribe)).error?.code).toBe(A2A_ERROR_CODES.unsupported_operation);
    const push = await serveA2aRpc(rpc('tasks/pushNotificationConfig/set', {}), 'support-bot');
    expect((await body(push)).error?.code).toBe(A2A_ERROR_CODES.push_notification_not_supported);
    const extended = await serveA2aRpc(
      rpc('agent/getAuthenticatedExtendedCard', {}),
      'support-bot',
    );
    expect((await body(extended)).error?.code).toBe(A2A_ERROR_CODES.unsupported_operation);
  });

  it('refuses what the agent cannot take: a task to continue, push, files, agent roles, other output', async () => {
    const message = (extra: Record<string, unknown>) => ({
      kind: 'message',
      messageId: 'm',
      role: 'user',
      parts: [{ kind: 'text', text: 'hi' }],
      ...extra,
    });
    const refusals: Array<[unknown, number]> = [
      [{ message: message({ taskId: AGENT }) }, A2A_ERROR_CODES.unsupported_operation],
      [
        {
          message: message({}),
          configuration: { pushNotificationConfig: { url: 'https://x.example' } },
        },
        A2A_ERROR_CODES.push_notification_not_supported,
      ],
      [
        { message: message({ parts: [{ kind: 'file', file: { uri: 'https://x.example/a' } }] }) },
        A2A_ERROR_CODES.content_type_not_supported,
      ],
      [{ message: message({ role: 'agent' }) }, A2A_ERROR_CODES.invalid_params],
      [
        { message: message({}), configuration: { acceptedOutputModes: ['image/png'] } },
        A2A_ERROR_CODES.content_type_not_supported,
      ],
    ];
    for (const [params, code] of refusals) {
      const response = await serveA2aRpc(rpc('message/send', params), 'support-bot');
      expect((await body(response)).error?.code, JSON.stringify(params)).toBe(code);
    }
    expect(launched).toHaveLength(0);
  });
});

describe('message/send', () => {
  it('runs the production version, waits for the answer and returns the completed task', async () => {
    const response = await serveA2aRpc(send('What is 2+2?'), 'support-bot');
    const result = await task(response);
    expect(result.status.state).toBe('completed');
    expect(result.contextId).toBe(SESSION);
    expect(result.artifacts?.[0]?.parts[0]?.text).toBe('Hello from the agent.');
    expect(result.history).toBeUndefined();
    expect(launched).toHaveLength(1);
    expect(launched[0]?.prompt).toBe('What is 2+2?');
    expect(openedVersions).toEqual([PRODUCTION_VERSION]);
  });

  it('joins several text parts and several messages in order', async () => {
    scenario = { chunks: ['first', 'second'], outcome: 'completed' };
    const response = await serveA2aRpc(
      rpc('message/send', {
        message: {
          kind: 'message',
          messageId: 'm',
          role: 'user',
          parts: [
            { kind: 'text', text: 'a' },
            { kind: 'text', text: 'b' },
          ],
        },
      }),
      'support-bot',
    );
    const result = await task(response);
    expect(launched[0]?.prompt).toBe('a\n\nb');
    expect(result.artifacts?.[0]?.parts[0]?.text).toBe('first\n\nsecond');
  });

  it('returns the submitted task at once when the client asks not to block', async () => {
    const result = await task(
      await serveA2aRpc(send('hi', {}, { blocking: false }), 'support-bot'),
    );
    expect(result.status.state).toBe('submitted');
    expect(result.artifacts).toBeUndefined();
  });

  it('returns the answer as history only when the client asks for it', async () => {
    const result = await task(
      await serveA2aRpc(send('hi', {}, { historyLength: 1 }), 'support-bot'),
    );
    expect(result.history?.[0]?.parts[0]?.text).toBe('Hello from the agent.');
  });

  it('answers a refused run start -32603 with its code and opens no session', async () => {
    const runs = getRunApi();
    if (runs === null) throw new Error('run API not installed');
    installTestRunApi({
      ...runs,
      preflight: () =>
        Promise.resolve({
          code: 'agent_runtime_profile_missing',
          message: 'the agent has no runtime profile',
        }),
    });
    const answer = await body(await serveA2aRpc(send('hi'), 'support-bot'));
    expect(answer.error?.code).toBe(A2A_ERROR_CODES.internal_error);
    expect(answer.error?.data).toEqual({ code: 'agent_runtime_profile_missing' });
    expect(openedVersions).toEqual([]);
    expect(launched).toHaveLength(0);
  });

  it('reports a failed run as a failed task carrying the run error, not a JSON-RPC error', async () => {
    scenario = { chunks: [], outcome: 'failed' };
    const result = await task(await serveA2aRpc(send('hi'), 'support-bot'));
    expect(result.status.state).toBe('failed');
    expect(result.status.message?.parts[0]?.text).toBe('the engine stopped');
  });

  it('continues a conversation named by contextId and answers every unusable one the same', async () => {
    const ok = await task(
      await serveA2aRpc(send('again', { contextId: SESSION }, { blocking: false }), 'support-bot'),
    );
    expect(ok.contextId).toBe(SESSION);
    const unknown = await serveA2aRpc(
      send('x', { contextId: OTHER_AGENT }, { blocking: false }),
      'support-bot',
    );
    const malformed = await serveA2aRpc(
      send('x', { contextId: 'not-a-uuid' }, { blocking: false }),
      'support-bot',
    );
    const first = await body(unknown);
    const second = await body(malformed);
    expect(first.error).toEqual({
      code: A2A_ERROR_CODES.invalid_params,
      message: 'unknown contextId',
    });
    expect(second.error).toEqual(first.error);
  });

  it('stops waiting after the blocking window and returns the task as it stands', async () => {
    scenario = { chunks: [], outcome: 'hang' };
    const request = send('hi');
    const runs = getRunApi();
    if (runs === null) throw new Error('run API not installed');
    const call: A2aCall = {
      request,
      runs,
      principal: principal(),
      credentialId: KEY_ID,
      agent: {
        agentId: AGENT,
        name: 'support-bot',
        productionVersionId: PRODUCTION_VERSION,
        versionNumber: 7,
      },
      agentRef: { id: AGENT, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' },
      now: () => Date.now(),
      blockingWaitMs: 30,
    };
    const response = await handleV03(call, await request.text());
    const result = await task(response);
    expect(['submitted', 'working']).toContain(result.status.state);
  });
});

describe('message/stream', () => {
  it('streams the task, the working status, the answer and a final completed status', async () => {
    scenario = { chunks: ['one', 'two'], outcome: 'completed' };
    const request = new Request(`${URL_BASE}/support-bot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-identity': 'owner',
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-9',
        method: 'message/stream',
        params: {
          message: {
            kind: 'message',
            messageId: 'm',
            role: 'user',
            parts: [{ kind: 'text', text: 'go' }],
          },
        },
      }),
    });
    const response = await serveA2aRpc(request, 'support-bot');
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    const sent = await frames(response);
    expect(sent.map((f) => f.result?.['kind'])).toEqual([
      'task',
      'status-update',
      'artifact-update',
      'artifact-update',
      'status-update',
    ]);
    const [, working, first, second, last] = sent.map((f) => f.result);
    expect((working?.['status'] as { state: string }).state).toBe('working');
    expect(first?.['append']).toBe(false);
    expect(second?.['append']).toBe(true);
    expect((second?.['artifact'] as { parts: Array<{ text: string }> }).parts[0]?.text).toBe(
      '\n\ntwo',
    );
    expect(last?.['final']).toBe(true);
    expect((last?.['status'] as { state: string }).state).toBe('completed');
  });

  it('ends a failed run with a final failed status carrying the run error', async () => {
    scenario = { chunks: [], outcome: 'failed' };
    const request = new Request(`${URL_BASE}/support-bot`, {
      method: 'POST',
      headers: { 'x-test-identity': 'owner', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'message/stream',
        params: {
          message: {
            kind: 'message',
            messageId: 'm',
            role: 'user',
            parts: [{ kind: 'text', text: 'go' }],
          },
        },
      }),
    });
    const sent = await frames(await serveA2aRpc(request, 'support-bot'));
    const last = sent[sent.length - 1]?.result;
    expect(last?.['final']).toBe(true);
    expect(
      (last?.['status'] as { state: string; message: { parts: Array<{ text: string }> } }).state,
    ).toBe('failed');
  });

  it('stops following when the client aborts, leaving the run running and uninterrupted', async () => {
    scenario = { chunks: ['partial'], outcome: 'hang' };
    const client = new AbortController();
    const request = new Request(`${URL_BASE}/support-bot`, {
      method: 'POST',
      headers: { 'x-test-identity': 'owner', Authorization: `Bearer ${SECRET}` },
      signal: client.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'message/stream',
        params: {
          message: {
            kind: 'message',
            messageId: 'm',
            role: 'user',
            parts: [{ kind: 'text', text: 'go' }],
          },
        },
      }),
    });
    const response = await serveA2aRpc(request, 'support-bot');
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('no stream body');
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('artifact-update')) {
      const next = await reader.read();
      if (next.done) throw new Error('the stream ended before the answer');
      text += decoder.decode(next.value);
    }
    client.abort();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value);
    }
    const runId = launched[0]?.run.id ?? '';
    expect((await store.get(runId))?.status).toBe('running');
    expect(interrupted).toEqual([]);
    expect(text).not.toContain('"final":true');
  });

  it('answers a refused start as an ordinary JSON-RPC error, not a stream', async () => {
    const request = new Request(`${URL_BASE}/support-bot`, {
      method: 'POST',
      headers: { 'x-test-identity': 'owner', Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'message/stream',
        params: {
          message: {
            kind: 'message',
            messageId: 'm',
            role: 'user',
            parts: [{ kind: 'text', text: 'go' }],
            contextId: OTHER_AGENT,
          },
        },
      }),
    });
    const response = await serveA2aRpc(request, 'support-bot');
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect((await body(response)).error?.code).toBe(A2A_ERROR_CODES.invalid_params);
  });
});

describe('tasks/get and tasks/cancel', () => {
  async function started(): Promise<string> {
    return (await task(await serveA2aRpc(send('hi', {}, { blocking: false }), 'support-bot'))).id;
  }

  it('returns a finished task with its answer', async () => {
    const id = await started();
    await vi.waitFor(async () => {
      expect((await store.get(id))?.status).toBe('completed');
    });
    const result = await task(await serveA2aRpc(rpc('tasks/get', { id }), 'support-bot'));
    expect(result.status.state).toBe('completed');
    expect(result.artifacts?.[0]?.parts[0]?.text).toBe('Hello from the agent.');
  });

  it('answers -32001 identically for a malformed, unknown, foreign-tenant, other-owner and other-agent task', async () => {
    const id = await started();
    foreignRuns.add(id);
    const elsewhere = await store.create({
      id: crypto.randomUUID(),
      workspaceId: OTHER_WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
      engine: 'claude-agent-sdk',
    });
    const otherAgent = await store.create({
      id: crypto.randomUUID(),
      workspaceId: WORKSPACE,
      agentId: OTHER_AGENT,
      sessionId: SESSION,
      engine: 'claude-agent-sdk',
    });
    const errors: unknown[] = [];
    for (const target of ['nope', crypto.randomUUID(), elsewhere.id, id, otherAgent.id]) {
      for (const method of ['tasks/get', 'tasks/cancel']) {
        const answer = await body(await serveA2aRpc(rpc(method, { id: target }), 'support-bot'));
        errors.push(answer.error);
      }
    }
    expect(errors).toHaveLength(10);
    for (const error of errors) {
      expect(error).toEqual({ code: A2A_ERROR_CODES.task_not_found, message: 'task not found' });
    }
  });

  it('cancels a live task and reports it canceled', async () => {
    scenario = { chunks: [], outcome: 'hang' };
    const id = await started();
    const result = await task(await serveA2aRpc(rpc('tasks/cancel', { id }), 'support-bot'));
    expect(result.status.state).toBe('canceled');
    expect((await store.get(id))?.status).toBe('cancelled');
  });

  it('answers -32002 for a task that has already finished', async () => {
    const id = await started();
    await vi.waitFor(async () => {
      expect((await store.get(id))?.status).toBe('completed');
    });
    const answer = await body(await serveA2aRpc(rpc('tasks/cancel', { id }), 'support-bot'));
    expect(answer.error?.code).toBe(A2A_ERROR_CODES.task_not_cancelable);
  });
});

describe('the run status a task reports', () => {
  it.each(RUN_STATUSES.map((status) => [status]))('maps %s', (status) => {
    expect(taskState(status)).toBe(
      {
        queued: 'submitted',
        running: 'working',
        awaiting_approval: 'input-required',
        completed: 'completed',
        failed: 'failed',
        cancelled: 'canceled',
      }[status],
    );
  });
});

describe('what the endpoint never says', () => {
  it('turns an infrastructure failure into -32603 with a fixed message and logs no credential', async () => {
    const logged = captureLog();
    openSessionFails = true;
    const response = await serveA2aRpc(send('hi'), 'support-bot');
    const text = await response.text();
    expect(response.status).toBe(200);
    const failure = A2aJsonRpcResponseSchema.parse(JSON.parse(text));
    expect('error' in failure && failure.error.code).toBe(A2A_ERROR_CODES.internal_error);
    expect('error' in failure && failure.error.message).toBe(
      'The agent endpoint could not complete the request.',
    );
    for (const output of [text, logged.text()]) {
      expect(output).not.toContain('hunter2');
      expect(output).not.toContain('postgres://');
      expect(output).not.toContain(SECRET);
    }
  });

  it('never echoes the bearer secret in any refusal', async () => {
    const outputs: string[] = [];
    for (const request of [
      rpc('tasks/get', { id: 'x' }, { identity: 'nobody' }),
      rpc('tasks/get', { id: 'x' }, { identity: 'session' }),
      rpc('tasks/get', { id: 'x' }, { agent: 'missing' }),
      rpc('tasks/get', { id: 'x' }, { headers: { 'A2A-Version': '9' } }),
      rpc('nope', {}),
    ]) {
      outputs.push(await (await serveA2aRpc(request, 'support-bot')).text());
    }
    for (const output of outputs) expect(output).not.toContain(SECRET);
  });
});

describe('the agent card', () => {
  const card = (identity = 'owner', agent = 'support-bot', headers: Record<string, string> = {}) =>
    serveA2aCard(
      new Request(`${URL_BASE}/${agent}/.well-known/agent-card.json`, {
        headers: { 'x-test-identity': identity, Authorization: `Bearer ${SECRET}`, ...headers },
      }),
      agent,
    );

  it('answers a key scoped to another agent, or an mcp-project key, with the unknown-name 404', async () => {
    const unknown = await card('owner', 'no-such-agent');
    for (const identity of ['scopedElsewhere', 'mcpKey']) {
      const response = await card(identity);
      expect(response.status, identity).toBe(404);
      expect(await response.text(), identity).toBe(await unknown.clone().text());
    }
  });

  it('serves a valid v0.3 card whose url is built from AW_PUBLIC_URL and the production version', async () => {
    vi.stubEnv('AW_PUBLIC_URL', 'https://aw.example.com');
    const response = await card();
    expect(response.status).toBe(200);
    const parsed = A2aAgentCardSchema.parse(await response.json());
    expect(parsed.url).toBe('https://aw.example.com/api/a2a/agents/support-bot');
    expect(parsed.version).toBe('7');
    expect(parsed.capabilities).toEqual({ streaming: true, pushNotifications: false });
  });

  it('answers 503 a2a_public_url_not_configured where AW_PUBLIC_URL is unset or invalid', async () => {
    for (const value of ['', 'ftp://aw.example.com', 'https://aw.example.com/path']) {
      vi.stubEnv('AW_PUBLIC_URL', value);
      const response = await card();
      expect(response.status, value).toBe(503);
      expect(await errorCodeOf(response)).toBe('a2a_public_url_not_configured');
    }
  });

  it('is behind the same credential, tenant and role checks as the endpoint', async () => {
    vi.stubEnv('AW_PUBLIC_URL', 'https://aw.example.com');
    expect((await card('nobody')).status).toBe(401);
    expect((await card('session')).status).toBe(403);
    expect((await card('otherTenant')).status).toBe(404);
    expect((await card('owner', 'missing')).status).toBe(404);
    expect((await card('viewer')).status).toBe(403);
    expect((await card('scopedElsewhere')).status).toBe(404);
    const fromBrowser = await card('owner', 'support-bot', { Origin: 'https://evil.example' });
    expect(fromBrowser.status).toBe(403);
    expect(await errorCodeOf(fromBrowser)).toBe('origin_not_allowed');
  });

  describe('without any credential (public discovery metadata, issue #1076)', () => {
    const publicCard = (agent = 'support-bot', headers: Record<string, string> = {}) =>
      serveA2aCard(
        new Request(`${URL_BASE}/${agent}/.well-known/agent-card.json`, { headers }),
        agent,
      );

    beforeEach(() => {
      vi.stubEnv('AW_PUBLIC_URL', 'https://aw.example.com');
    });

    it('serves the card of a published agent with its fields and nothing secret-shaped', async () => {
      const response = await publicCard();
      expect(response.status).toBe(200);
      const text = await response.text();
      const parsed = A2aAgentCardSchema.parse(JSON.parse(text));
      expect(parsed.name).toBe('support-bot');
      expect(parsed.url).toBe('https://aw.example.com/api/a2a/agents/support-bot');
      expect(parsed.version).toBe('7');
      expect(parsed.skills.map((skill) => skill.id)).toEqual(['support-bot']);
      expect(Object.keys(parsed.securitySchemes ?? {})).toEqual(['awBearer']);
      for (const forbidden of [SECRET, AGENT, PRODUCTION_VERSION, WORKSPACE, 'ak_live', 'aw_']) {
        expect(text, forbidden).not.toContain(forbidden);
      }
    });

    it('answers every name the deployment lookup misses with one identical 404', async () => {
      const bodies = new Set<string>();
      for (const name of ['no-such-agent', 'billing-bot', 'unpublished']) {
        const response = await publicCard(name);
        expect(response.status, name).toBe(404);
        bodies.add(await response.text());
      }
      expect(bodies.size).toBe(1);
    });

    it('still answers 401 to the message and task endpoint', async () => {
      const response = await serveA2aRpc(
        new Request(`${URL_BASE}/support-bot`, { method: 'POST', body: '{}' }),
        'support-bot',
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toMatch(/^Bearer realm="agent-workspace"/u);
    });

    it('refuses a browser Origin', async () => {
      const response = await publicCard('support-bot', { Origin: 'https://evil.example' });
      expect(response.status).toBe(403);
      expect(await errorCodeOf(response)).toBe('origin_not_allowed');
    });

    it('answers 503 a2a_public_url_not_configured where AW_PUBLIC_URL is unset', async () => {
      vi.stubEnv('AW_PUBLIC_URL', '');
      const response = await publicCard();
      expect(response.status).toBe(503);
      expect(await errorCodeOf(response)).toBe('a2a_public_url_not_configured');
    });

    it('is rate limited per client address, and an over-limit call looks nothing up', async () => {
      const a2a = installedA2a();
      if (a2a === null) throw new Error('the A2A environment is not installed');
      const findDeploymentAgent = vi.fn((name: string) => a2a.findDeploymentAgent(name));
      installA2a({ ...a2a, findDeploymentAgent });
      // No AW_TRUSTED_PROXY_HOPS: callers share one bucket ten times the per-address limit.
      const limit = A2A_RATE_LIMITS.cardFetchesPerAddressPerMinute * 10;
      for (let i = 0; i < limit; i += 1) expect((await publicCard()).status).toBe(200);
      findDeploymentAgent.mockClear();
      const over = await publicCard();
      expect(over.status).toBe(429);
      expect(await errorCodeOf(over)).toBe('a2a_rate_limited');
      expect(over.headers.get('Retry-After')).toMatch(/^\d+$/u);
      expect(findDeploymentAgent).not.toHaveBeenCalled();
    });
  });

  it('answers 503 a2a_not_configured when the endpoint is not installed', async () => {
    clearApplicationContext();
    const response = await card();
    expect(response.status).toBe(503);
  });

  it('answers the same 503 while the endpoint is disabled, to a call and a card fetch', async () => {
    installTestDomains({ a2a: { kind: 'disabled' } });
    const rpcResponse = await serveA2aRpc(rpc('tasks/get', { id: 'x' }), 'support-bot');
    expect(rpcResponse.status).toBe(503);
    expect(await errorCodeOf(rpcResponse)).toBe('a2a_not_configured');
    const cardResponse = await card();
    expect(cardResponse.status).toBe(503);
    expect(await errorCodeOf(cardResponse)).toBe('a2a_not_configured');
  });

  it('answers 401, not 503, to an RPC with no credential at all, installed or not', async () => {
    clearApplicationContext();
    resetTestRunApi();
    const response = await serveA2aRpc(
      new Request(`${URL_BASE}/support-bot`, { method: 'POST' }),
      'x',
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer realm="agent-workspace"');
  });

  it('answers 503 a2a_not_configured to a credential-less card fetch when nothing is installed', async () => {
    clearApplicationContext();
    const response = await serveA2aCard(
      new Request(`${URL_BASE}/support-bot/.well-known/agent-card.json`),
      'support-bot',
    );
    expect(response.status).toBe(503);
    expect(await errorCodeOf(response)).toBe('a2a_not_configured');
  });
});
