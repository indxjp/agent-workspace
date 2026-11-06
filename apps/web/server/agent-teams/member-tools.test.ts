/**
 * The member endpoint (ADR-0104 acceptance decisions 4 to 9, issue #1517) over the in-memory run
 * store and an in-process launcher double that settles each child run as a runtime would.
 */
import { describe, expect, it } from 'vitest';

import type { AgentRef, LaunchContext, RunApiEnvironment, RunPrincipal } from '../runs/environment';
import { InMemoryRunStore } from '../runs/memory-store';
import type { RunOutput } from '../runs/store';
import { createRunTokenCodec } from '@agent-workspace/gateway/tokens';

import {
  createMemberCallerVerifier,
  memberAnswer,
  serveMemberTools,
  type MemberToolsEnvironment,
} from './member-tools';
import type { AgentTeamVersionRecord, LeadRunCaller } from './runtime';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const LEAD_RUN = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN = '11111111-1111-4111-8111-999999999999';
const LEAD_AGENT = '33333333-3333-4333-8333-333333333330';
const WRITER = '33333333-3333-4333-8333-333333333331';
const CRITIC = '33333333-3333-4333-8333-333333333332';
const VERSION_ID = '55555555-5555-4555-8555-555555555555';
const PERSON: RunPrincipal = {
  principalId: '77777777-7777-4777-8777-777777777777',
  ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
  userId: '66666666-6666-4666-8666-666666666666',
  workspaceId: WORKSPACE,
  role: 'builder',
  scope: null,
  via: 'session',
  kind: 'membership',
};

const VERSION: AgentTeamVersionRecord = {
  id: VERSION_ID,
  teamId: '44444444-4444-4444-8444-444444444444',
  workspaceId: WORKSPACE,
  number: 1,
  mode: 'handoff',
  lead: { agentId: LEAD_AGENT, agentVersionId: '66666666-0000-4000-8000-000000000000' },
  members: [
    { name: 'critic', agentId: CRITIC, agentVersionId: '66666666-0000-4000-8000-000000000002' },
    { name: 'writer', agentId: WRITER, agentVersionId: '66666666-0000-4000-8000-000000000001' },
  ],
  createdBy: null,
  createdAt: new Date('2026-11-01T00:00:00.000Z'),
};

/** How the double settles a child run of each member agent. */
type Settle = (run: string) => {
  status: 'completed' | 'failed';
  error?: string;
  output?: RunOutput;
};

async function harness(
  options: {
    readonly settle?: Settle;
    readonly mayRun?: boolean;
    readonly person?: boolean;
    /** The child runs and never stops by itself, as a long member task. */
    readonly hold?: boolean;
    /** Runs once the person was found allowed, between the endpoint's admission and the insert. */
    readonly beforeStart?: (store: InMemoryRunStore) => Promise<void>;
  } = {},
) {
  const store = new InMemoryRunStore();
  const launches: LaunchContext[] = [];
  const settle: Settle =
    options.settle ??
    (() => ({ status: 'completed', output: { text: 'the member answered', structured: null } }));
  const runs: RunApiEnvironment = {
    authenticate: () => Promise.resolve(null),
    findAgent: (_principal, agentId): Promise<AgentRef | null> =>
      Promise.resolve({ id: agentId, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' }),
    openSession: (_principal, agent, requested) =>
      Promise.resolve({ id: requested ?? crypto.randomUUID(), agentId: agent.id, engine: null }),
    ownsRun: () => Promise.resolve(true),
    store,
    launch: (context) => {
      launches.push(context);
      // The runtime starts and settles the child once the start has returned, as a launch does.
      setTimeout(() => {
        void (async () => {
          await store.markRunning(context.run.id);
          if (options.hold === true) return;
          const outcome = settle(context.agent.id);
          await store.finish(
            context.run.id,
            outcome.status,
            outcome.error ?? null,
            true,
            outcome.output ?? null,
          );
        })();
      }, 0);
    },
    interruptRun: async (_principal, run) => {
      await store.finish(run.id, 'cancelled', 'the run was interrupted by request', true);
    },
  };
  await store.create({
    id: LEAD_RUN,
    workspaceId: WORKSPACE,
    agentId: LEAD_AGENT,
    sessionId: '88888888-8888-4888-8888-888888888888',
    engine: 'claude-agent-sdk',
    agentTeamVersionId: VERSION_ID,
  });
  await store.markRunning(LEAD_RUN);
  const callers: Record<string, LeadRunCaller> = {
    'Bearer lead-token': {
      runId: LEAD_RUN,
      workspaceId: WORKSPACE,
      expiresAtMs: Date.now() + 60_000,
      person: options.person === false ? null : PERSON,
    },
    'Bearer other-token': {
      runId: OTHER_RUN,
      workspaceId: WORKSPACE,
      expiresAtMs: Date.now() + 60_000,
      person: PERSON,
    },
  };
  const env: MemberToolsEnvironment = {
    verifyCaller: (authorization) => Promise.resolve(callers[authorization ?? ''] ?? null),
    runs,
    teamVersion: (workspaceId, versionId) =>
      Promise.resolve(workspaceId === WORKSPACE && versionId === VERSION_ID ? VERSION : null),
    mayRunAgent: async () => {
      await options.beforeStart?.(store);
      return options.mayRun ?? true;
    },
    pollIntervalMs: 1,
  };
  return { env, store, launches };
}

function rpc(
  method: string,
  params?: unknown,
  headers: Record<string, string> = { authorization: 'Bearer lead-token' },
  runId = LEAD_RUN,
): Request {
  return new Request(`http://web.test/api/runs/${runId}/members/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });
}

const call = (name: string, prompt: string, toolUseId?: string) =>
  rpc('tools/call', {
    name,
    arguments: { prompt },
    ...(toolUseId === undefined ? {} : { _meta: { 'claudecode/toolUseId': toolUseId } }),
  });

interface ToolResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly isError: boolean;
}

async function resultOf(response: Response): Promise<ToolResult> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result: ToolResult };
  return body.result;
}

function errorOf(result: ToolResult): { code: string; failure?: string | null } {
  expect(result.isError).toBe(true);
  return JSON.parse(result.content[0]?.text ?? '{}') as { code: string; failure?: string | null };
}

describe('POST /api/runs/:id/members/mcp — who may call', () => {
  it('refuses a run token for another run with 403, and every other credential with 401', async () => {
    const { env } = await harness();
    expect(
      (
        await serveMemberTools(
          rpc('tools/list', {}, { authorization: 'Bearer other-token' }),
          LEAD_RUN,
          env,
        )
      ).status,
    ).toBe(403);
    for (const headers of [
      {},
      { cookie: 'aw_session=signed-in-person' },
      { authorization: 'Bearer ak_live_workspacekey' },
      { authorization: 'Bearer awu_live_clitoken' },
    ]) {
      expect((await serveMemberTools(rpc('tools/list', {}, headers), LEAD_RUN, env)).status).toBe(
        401,
      );
    }
  });

  it('refuses the token of the run in the path when that run has finished', async () => {
    const { env, store } = await harness();
    await store.finish(LEAD_RUN, 'completed', null);
    const response = await serveMemberTools(rpc('tools/list', {}), LEAD_RUN, env);
    expect(response.status).toBe(403);
  });

  it('refuses a run that is not a team lead, and accepts only POST', async () => {
    const { env, store } = await harness();
    await store.create({
      id: OTHER_RUN,
      workspaceId: WORKSPACE,
      agentId: LEAD_AGENT,
      sessionId: '88888888-8888-4888-8888-000000000000',
      engine: 'claude-agent-sdk',
    });
    await store.markRunning(OTHER_RUN);
    const plain = await serveMemberTools(
      rpc('tools/list', {}, { authorization: 'Bearer other-token' }, OTHER_RUN),
      OTHER_RUN,
      env,
    );
    expect(plain.status).toBe(403);
    const get = await serveMemberTools(
      new Request(`http://web.test/api/runs/${LEAD_RUN}/members/mcp`),
      LEAD_RUN,
      env,
    );
    expect(get.status).toBe(405);
  });
});

describe('POST /api/runs/:id/members/mcp — the member tools', () => {
  it('lists one tool per member, by its member name, taking a prompt', async () => {
    const { env } = await harness();
    const response = await serveMemberTools(rpc('tools/list', {}), LEAD_RUN, env);
    const body = (await response.json()) as {
      result: { tools: { name: string; inputSchema: { required: string[] } }[] };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual(['critic', 'writer']);
    expect(body.result.tools[0]?.inputSchema.required).toEqual(['prompt']);
  });

  it("starts a child run of the member's pinned version and answers with its output", async () => {
    const { env, store, launches } = await harness();
    const result = await resultOf(
      await serveMemberTools(call('writer', 'Draft it.'), LEAD_RUN, env),
    );
    expect(result).toEqual({
      content: [{ type: 'text', text: 'the member answered' }],
      isError: false,
    });
    const [child] = await store.listChildren(WORKSPACE, LEAD_RUN, 16);
    expect(child).toMatchObject({ agentId: WRITER, parentRunId: LEAD_RUN, status: 'completed' });
    // The member runs as the person behind the lead run, never as anyone else.
    expect(launches[0]?.principal).toBe(PERSON);
    expect(launches[0]?.prompt).toBe('Draft it.');
  });

  it('replays a retried tool call to the child it already started', async () => {
    const { env, store } = await harness();
    await serveMemberTools(call('writer', 'Draft it.', 'toolu_1'), LEAD_RUN, env);
    await serveMemberTools(call('writer', 'Draft it.', 'toolu_1'), LEAD_RUN, env);
    expect(await store.listChildren(WORKSPACE, LEAD_RUN, 16)).toHaveLength(1);
  });

  it('answers the 17th member call of one root with team_member_limit, starting nothing', async () => {
    const { env, store } = await harness();
    for (let index = 0; index < 16; index += 1) {
      const result = await resultOf(
        await serveMemberTools(
          call(index % 2 === 0 ? 'writer' : 'critic', `task ${String(index)}`),
          LEAD_RUN,
          env,
        ),
      );
      expect(result.isError).toBe(false);
    }
    const over = errorOf(
      await resultOf(await serveMemberTools(call('writer', 'one more'), LEAD_RUN, env)),
    );
    expect(over.code).toBe('team_member_limit');
    expect(await store.listChildren(WORKSPACE, LEAD_RUN, 16)).toHaveLength(16);
  });

  it('turns a failed child into a tool error with its public code, and the lead keeps running', async () => {
    const { env, store } = await harness({
      settle: (agent) =>
        agent === CRITIC
          ? { status: 'failed', error: 'model_unavailable: the provider said: secret detail' }
          : { status: 'completed', output: { text: 'ok', structured: null } },
    });
    const result = await resultOf(
      await serveMemberTools(call('critic', 'Review it.'), LEAD_RUN, env),
    );
    expect(errorOf(result)).toMatchObject({
      code: 'team_member_failed',
      failure: 'model_unavailable',
    });
    expect(result.content[0]?.text).not.toContain('secret detail');
    expect((await store.get(LEAD_RUN))?.status).toBe('running');
  });

  it('refuses a member the person may not run, a run with no person, and an unknown member', async () => {
    const forbidden = await harness({ mayRun: false });
    expect(
      errorOf(await resultOf(await serveMemberTools(call('writer', 'x'), LEAD_RUN, forbidden.env)))
        .code,
    ).toBe('team_member_forbidden');
    const nobody = await harness({ person: false });
    expect(
      errorOf(await resultOf(await serveMemberTools(call('writer', 'x'), LEAD_RUN, nobody.env)))
        .code,
    ).toBe('team_member_forbidden');
    const { env, store } = await harness();
    expect(
      errorOf(await resultOf(await serveMemberTools(call('editor', 'x'), LEAD_RUN, env))).code,
    ).toBe('team_member_unknown');
    expect(
      errorOf(await resultOf(await serveMemberTools(call('writer', ' '), LEAD_RUN, env))).code,
    ).toBe('team_member_invalid_arguments');
    expect(await store.listChildren(WORKSPACE, LEAD_RUN, 16)).toEqual([]);
  });

  it('starts no child when the root is interrupted after admission, before the insert', async () => {
    const { env, store, launches } = await harness({
      // The interrupt lands after `admit()` read the lead as running: its cascade lists no child.
      beforeStart: async (runs) => {
        await runs.finish(LEAD_RUN, 'cancelled', 'the run was interrupted by request', true);
      },
    });
    const refused = errorOf(
      await resultOf(await serveMemberTools(call('writer', 'Draft it.'), LEAD_RUN, env)),
    );
    expect(refused).toMatchObject({ code: 'team_member_refused', failure: 'parent_run_stopped' });
    expect(await store.listChildren(WORKSPACE, LEAD_RUN, 16)).toEqual([]);
    expect(launches).toEqual([]);
  });

  it('interrupts a child it waits on as soon as the root stops, and answers team_member_cancelled', async () => {
    const { env, store } = await harness({ hold: true });
    const answer = serveMemberTools(call('writer', 'A long task.'), LEAD_RUN, env);
    let child = (await store.listChildren(WORKSPACE, LEAD_RUN, 16))[0];
    while (child?.status !== 'running') {
      await new Promise((resolve) => setTimeout(resolve, 1));
      child = (await store.listChildren(WORKSPACE, LEAD_RUN, 16))[0];
    }
    // The root stops without its cascade reaching this child (the cascade read the children first).
    await store.finish(LEAD_RUN, 'cancelled', 'the run was interrupted by request', true);
    expect(errorOf(await resultOf(await answer)).code).toBe('team_member_cancelled');
    expect((await store.get(child.id))?.status).toBe('cancelled');
  });

  it('answers initialize and ping locally', async () => {
    const { env } = await harness();
    const init = (await (
      await serveMemberTools(rpc('initialize', { protocolVersion: '2025-06-18' }), LEAD_RUN, env)
    ).json()) as { result: { capabilities: unknown } };
    expect(init.result.capabilities).toEqual({ tools: {} });
  });
});

describe('memberAnswer', () => {
  it('maps every stopped status to the tool result the lead sees', () => {
    expect(errorOf(memberAnswer(null)).code).toBe('team_member_failed');
  });
});

describe('createMemberCallerVerifier', () => {
  const SECRET = 'member-tools-signing-secret-at-least-32-bytes';
  const SESSION = '88888888-8888-4888-8888-888888888888';

  async function verifierFor(
    caller: { sub: string; principalKind: 'membership' | 'api-key' } | null,
  ) {
    const tokens = createRunTokenCodec({ secret: SECRET });
    const token = await tokens.issue({
      runId: LEAD_RUN,
      sessionId: SESSION,
      workspaceId: WORKSPACE,
      agentId: LEAD_AGENT,
      modelConnectionId: 'model-1',
      ...(caller === null ? {} : { caller }),
    });
    const verify = createMemberCallerVerifier({
      tokens,
      database: {
        scopes: { forWorkspaceId: () => Promise.resolve('scope') },
        runTokens: { forScope: () => ({ isActive: () => Promise.resolve(true) }) },
        runs: {
          forScope: () => ({
            get: () =>
              Promise.resolve({
                sessionId: SESSION,
                workspaceId: WORKSPACE,
                agentId: LEAD_AGENT,
                status: 'running' as const,
              }),
          }),
        },
      },
      directory: {
        forWorkspace: () => ({
          findMembershipByPrincipal: (principalId: string) =>
            Promise.resolve(
              principalId === PERSON.principalId
                ? {
                    id: 'membership-1',
                    principalId,
                    userId: PERSON.userId ?? '',
                    email: 'ada@example.com',
                    name: 'Ada',
                    role: 'builder' as const,
                    createdAt: '2026-11-01T00:00:00.000Z',
                  }
                : null,
            ),
        }),
      },
    });
    return { verify, token };
  }

  it('names the lead run and the member behind it, as a membership principal', async () => {
    const { verify, token } = await verifierFor({
      sub: PERSON.principalId,
      principalKind: 'membership',
    });
    const caller = await verify(`Bearer ${token}`);
    expect(caller).toMatchObject({ runId: LEAD_RUN, workspaceId: WORKSPACE, person: PERSON });
    expect(caller?.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it('finds no person behind an API-key caller or no caller, and no run for a bad bearer', async () => {
    const keyed = await verifierFor({ sub: 'customer-42', principalKind: 'api-key' });
    expect((await keyed.verify(`Bearer ${keyed.token}`))?.person).toBeNull();
    const nobody = await verifierFor(null);
    expect((await nobody.verify(`Bearer ${nobody.token}`))?.person).toBeNull();
    expect(await nobody.verify('Bearer not-a-run-token')).toBeNull();
    expect(await nobody.verify(null)).toBeNull();
    expect(await createMemberCallerVerifier(null)(`Bearer ${nobody.token}`)).toBeNull();
  });
});
