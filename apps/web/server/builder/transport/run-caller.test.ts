import { createHash } from 'node:crypto';

import {
  createInMemoryWorkspaceScopeResolver,
  type WorkspaceScope,
} from '@agent-workspace/core/db';
import { createRunTokenCodec, type RunTokenSubject } from '@agent-workspace/gateway/tokens';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunStatus } from '@indx-workspace/contracts/runs';

import { conferredBy } from '../../rbac/conferral';
import { createMemoryDirectory } from '../../rbac/memory-directory';
import type { RunTokenDatabase } from '../../gateway/run-token-verifier';
import type { AgentRecord } from '../../agents/contract';
import { createAuthorization } from '../adapters/authorization/production';
import { draftBody } from '../adapters/checker/checker.contract';
import { toCallContext } from './call-context';
import { serveBuilderMcp, createBuilderCallerVerifier, type BuilderDoor } from './mcp';
import { verifyRunCaller, type RunCallerDeps } from './run-caller';

const SECRET = 'run-caller-test-signing-secret-at-least-thirty-two-bytes';
const WORKSPACE = 'ws-1';
const OTHER_WORKSPACE = 'ws-2';
const RUN = 'run-1';
const SESSION = 'session-1';
const AGENT = 'agent-1';
const MEMBER = 'principal-member';
const START = 1_000;

interface Registered {
  readonly workspaceId: string;
  readonly runId: string;
  readonly hash: string;
  readonly expiresAt: number;
  revoked: boolean;
}

interface RunRow {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  status: RunStatus;
}

function setup(): {
  readonly now: { value: number };
  readonly database: RunTokenDatabase<WorkspaceScope>;
  readonly directory: ReturnType<typeof createMemoryDirectory>;
  readonly registered: Map<string, Registered>;
  readonly runs: Map<string, RunRow>;
  readonly issue: (
    subject?: Partial<RunTokenSubject>,
    registerAs?: { readonly runId?: string },
  ) => Promise<string>;
  readonly tokens: ReturnType<typeof createRunTokenCodec>;
  readonly agentRows: Map<string, Pick<AgentRecord, 'builtin'>>;
  readonly deps: RunCallerDeps<WorkspaceScope>;
} {
  const now = { value: START };
  const agentRows = new Map<string, Pick<AgentRecord, 'builtin'>>([
    [AGENT, { builtin: 'builder' }],
  ]);
  const tokens = createRunTokenCodec({ secret: SECRET, now: () => now.value });
  const scopes = createInMemoryWorkspaceScopeResolver([
    { id: WORKSPACE, slug: WORKSPACE },
    { id: OTHER_WORKSPACE, slug: OTHER_WORKSPACE },
  ]);
  const registered = new Map<string, Registered>();
  const runs = new Map<string, RunRow>([
    [RUN, { sessionId: SESSION, workspaceId: WORKSPACE, agentId: AGENT, status: 'running' }],
  ]);
  const database: RunTokenDatabase<WorkspaceScope> = {
    scopes,
    runTokens: {
      forScope: (scope) => ({
        isActive: (id, runId, tokenHash) => {
          const row = registered.get(id);
          return Promise.resolve(
            row !== undefined &&
              row.workspaceId === scope.workspaceId &&
              row.runId === runId &&
              row.hash === tokenHash &&
              !row.revoked &&
              row.expiresAt > now.value,
          );
        },
      }),
    },
    runs: {
      forScope: (scope) => ({
        get: (runId) => {
          const row = runs.get(runId);
          return Promise.resolve(row?.workspaceId === scope.workspaceId ? row : null);
        },
      }),
    },
  };
  const directory = createMemoryDirectory({
    users: [
      {
        id: 'user-member',
        principalId: MEMBER,
        email: 'member@example.test',
        name: 'Member',
        workspaceId: WORKSPACE,
        role: 'builder',
      },
    ],
  });
  const issue = async (
    subject: Partial<RunTokenSubject> = {},
    registerAs: { readonly runId?: string } = {},
  ): Promise<string> => {
    const token = await tokens.issue({
      runId: RUN,
      sessionId: SESSION,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      modelConnectionId: 'connection-1',
      ...subject,
    });
    const verified = await tokens.verify(token);
    if (!verified.ok) throw new Error('fixture token did not verify');
    registered.set(verified.claims.tokenId, {
      workspaceId: verified.claims.workspaceId,
      runId: registerAs.runId ?? verified.claims.runId,
      hash: createHash('sha256').update(token).digest('hex'),
      expiresAt: verified.claims.expiresAt,
      revoked: false,
    });
    return token;
  };
  return {
    now,
    database,
    directory,
    registered,
    runs,
    issue,
    tokens,
    agentRows,
    deps: {
      tokens,
      database,
      directory,
      agents: {
        forWorkspace: () => ({ get: (id) => Promise.resolve(agentRows.get(id) ?? null) }),
      },
    },
  };
}

const bearer = (token: string): string => `Bearer ${token}`;

/** The door around the real verifier; these tests never get as far as a tool. */
const doorOf = (verifyCaller: BuilderDoor['verifyCaller']): BuilderDoor => ({
  verifyCaller,
  ports: null,
  readRun: () => Promise.reject(new Error('the run must not be read')),
});

/** The run a token names, as a reads-only refusal carries it. */
const RUN_IDENTITY = {
  kind: 'run',
  workspaceId: WORKSPACE,
  runId: RUN,
  sessionId: SESSION,
  agentId: AGENT,
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('verifyRunCaller', () => {
  it('a run token with no caller cannot use a write tool', async () => {
    const s = setup();
    const token = await s.issue();
    const result = await verifyRunCaller(bearer(token), s.deps);
    expect(result).toEqual({ ok: false, code: 'no_caller', reads: true, run: RUN_IDENTITY });
  });

  it('resolves a member to their current role, read from the directory on every call', async () => {
    const s = setup();
    const token = await s.issue({ caller: { sub: MEMBER, principalKind: 'membership' } });
    expect(await verifyRunCaller(bearer(token), s.deps)).toEqual({
      ok: true,
      caller: {
        kind: 'run-caller',
        workspaceId: WORKSPACE,
        runId: RUN,
        sessionId: SESSION,
        agentId: AGENT,
        principalId: MEMBER,
        userId: 'user-member',
        role: 'builder',
      },
    });
    const [membership] = await s.directory.forWorkspace(WORKSPACE).listMemberships();
    if (membership === undefined) throw new Error('fixture membership missing');
    await s.directory
      .forWorkspace(WORKSPACE)
      .changeMembershipRole(membership.id, conferredBy('owner', 'viewer', 'run-caller.test'));
    const after = await verifyRunCaller(bearer(token), s.deps);
    expect(after.ok && after.caller.role).toBe('viewer');
  });

  it('refuses a removed member without reads', async () => {
    const s = setup();
    const token = await s.issue({ caller: { sub: MEMBER, principalKind: 'membership' } });
    const [membership] = await s.directory.forWorkspace(WORKSPACE).listMemberships();
    if (membership === undefined) throw new Error('fixture membership missing');
    await s.directory.forWorkspace(WORKSPACE).deleteMembership(membership.id);
    expect(await verifyRunCaller(bearer(token), s.deps)).toEqual({
      ok: false,
      code: 'no_caller',
      reads: false,
    });
  });

  it('gives an api-key caller with a subject no write role, reads allowed', async () => {
    const s = setup();
    const token = await s.issue({ caller: { sub: 'customer-7', principalKind: 'api-key' } });
    expect(await verifyRunCaller(bearer(token), s.deps)).toEqual({
      ok: false,
      code: 'no_caller',
      reads: true,
      run: RUN_IDENTITY,
    });
  });

  it('a subject-less API key run carries no caller, so it is no_caller', async () => {
    // runCallerOf (apps/web/server/runs/caller.ts) emits no caller for a key without a subject.
    const s = setup();
    const token = await s.issue({ caller: undefined });
    expect(await verifyRunCaller(bearer(token), s.deps)).toEqual({
      ok: false,
      code: 'no_caller',
      reads: true,
      run: RUN_IDENTITY,
    });
  });

  it('refuses a membership caller whose membership is in another workspace than the token', async () => {
    const s = setup();
    s.runs.set(RUN, {
      sessionId: SESSION,
      workspaceId: OTHER_WORKSPACE,
      agentId: AGENT,
      status: 'running',
    });
    const token = await s.issue({
      workspaceId: OTHER_WORKSPACE,
      caller: { sub: MEMBER, principalKind: 'membership' },
    });
    expect(await verifyRunCaller(bearer(token), s.deps)).toEqual({
      ok: false,
      code: 'no_caller',
      reads: false,
    });
  });

  it('never lets a visitor reach the control plane, reads included', async () => {
    const s = setup();
    const token = await s.issue({ caller: { sub: 'visitor-1', principalKind: 'visitor' } });
    expect(await verifyRunCaller(bearer(token), s.deps)).toEqual({
      ok: false,
      code: 'no_caller',
      reads: false,
    });
  });

  describe('token failures are refused as not_permitted, without reads', () => {
    const refused = { ok: false, code: 'not_permitted', reads: false };
    const member = { caller: { sub: MEMBER, principalKind: 'membership' } } as const;

    it('an expired token (TTL 300 s, injected clock)', async () => {
      const s = setup();
      const token = await s.issue(member);
      s.now.value = START + 299;
      expect((await verifyRunCaller(bearer(token), s.deps)).ok).toBe(true);
      s.now.value = START + 300;
      expect(await verifyRunCaller(bearer(token), s.deps)).toEqual(refused);
    });

    it('a revoked token', async () => {
      const s = setup();
      const token = await s.issue(member);
      for (const row of s.registered.values()) row.revoked = true;
      expect(await verifyRunCaller(bearer(token), s.deps)).toEqual(refused);
    });

    it.each(['completed', 'awaiting_approval'] as const)(
      'a run that has stopped (%s)',
      async (status) => {
        const s = setup();
        const token = await s.issue(member);
        const run = s.runs.get(RUN);
        if (run === undefined) throw new Error('fixture run missing');
        run.status = status;
        expect(await verifyRunCaller(bearer(token), s.deps)).toEqual(refused);
      },
    );

    it('a run in another workspace than the token names', async () => {
      const s = setup();
      s.runs.set(RUN, {
        sessionId: SESSION,
        workspaceId: OTHER_WORKSPACE,
        agentId: AGENT,
        status: 'running',
      });
      const token = await s.issue(member);
      expect(await verifyRunCaller(bearer(token), s.deps)).toEqual(refused);
    });

    it('a token registered for a different run id', async () => {
      const s = setup();
      const token = await s.issue(member, { runId: 'run-2' });
      expect(await verifyRunCaller(bearer(token), s.deps)).toEqual(refused);
    });

    it('a token whose session or agent does not match the run row', async () => {
      const s = setup();
      const token = await s.issue({ ...member, agentId: 'agent-2' });
      expect(await verifyRunCaller(bearer(token), s.deps)).toEqual(refused);
    });

    it.each([null, '', 'Bearer', 'Bearer not-a-token', 'Basic abc'])(
      'a missing or malformed bearer (%s)',
      async (authorization) => {
        const s = setup();
        expect(await verifyRunCaller(authorization, s.deps)).toEqual(refused);
      },
    );

    it('a directory lookup that throws', async () => {
      const s = setup();
      const token = await s.issue(member);
      expect(
        await verifyRunCaller(bearer(token), {
          ...s.deps,
          directory: {
            forWorkspace: () => {
              throw new Error('directory exploded');
            },
          },
        }),
      ).toEqual(refused);
    });

    it('a database lookup that rejects', async () => {
      const s = setup();
      const token = await s.issue(member);
      expect(
        await verifyRunCaller(bearer(token), {
          ...s.deps,
          database: {
            ...s.database,
            scopes: { forWorkspaceId: () => Promise.reject(new Error('database exploded')) },
          },
        }),
      ).toEqual(refused);
    });
  });

  it('puts no token, subject or error text in a result or a log line', async () => {
    const s = setup();
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    const token = await s.issue({ caller: { sub: MEMBER, principalKind: 'membership' } });
    const results = [
      await verifyRunCaller(bearer(token), {
        ...s.deps,
        directory: {
          forWorkspace: () => {
            throw new Error(`leaky ${token}`);
          },
        },
      }),
      await verifyRunCaller(bearer(token), {
        ...s.deps,
        directory: createMemoryDirectory(),
      }),
    ];
    const seen = JSON.stringify(results) + JSON.stringify([...out.mock.calls, ...err.mock.calls]);
    expect(seen).not.toContain(token);
    expect(seen).not.toContain(MEMBER);
    expect(seen).not.toContain('leaky');
  });
});

describe('the Builder-only door (#1846)', () => {
  const member = { caller: { sub: MEMBER, principalKind: 'membership' } } as const;
  const rpc = (token: string, method: string, params?: unknown): Request =>
    new Request('http://localhost/api/builder/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: bearer(token) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
    });

  it('refuses a valid run token of an agent row that is gone on every method, naming no token or claim', async () => {
    const s = setup();
    s.agentRows.clear();
    const token = await s.issue(member);
    const logged = (['log', 'error', 'warn', 'info'] as const).map((level) =>
      vi.spyOn(console, level),
    );
    const verifyCaller = createBuilderCallerVerifier(s.deps);
    for (const [method, params] of [
      ['initialize', undefined],
      ['tools/list', undefined],
      ['tools/call', { name: 'catalog_list', arguments: {} }],
    ] as const) {
      const response = await serveBuilderMcp(rpc(token, method, params), doorOf(verifyCaller));
      const text = await response.text();
      expect(response.status).toBe(403);
      expect(JSON.parse(text)).toMatchObject({ error: { code: 'not_allowed_to_build' } });
      for (const secret of [token, MEMBER, WORKSPACE, RUN, SESSION, AGENT]) {
        expect(text).not.toContain(secret);
      }
    }
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });

  it('admits the run of a user agent and resolves it to an agent creator, not the Builder', async () => {
    const s = setup();
    s.agentRows.set(AGENT, {});
    const token = await s.issue(member);
    const verified = await verifyRunCaller(bearer(token), s.deps);
    expect(verified).toMatchObject({ ok: true, caller: { agentId: AGENT, principalId: MEMBER } });
    if (!verified.ok) throw new Error('the run was not admitted');

    const body = draftBody('Planner');
    const authorization = createAuthorization({
      agents: {
        forWorkspace: () => ({
          get: (id) =>
            Promise.resolve({
              id,
              ownerPrincipalId: MEMBER,
              name: 'planner',
              ...s.agentRows.get(id),
            }),
        }),
      },
      versions: { forWorkspace: () => Promise.resolve({ find: () => Promise.resolve({ body }) }) },
      ceiling: null,
    });
    const ctx = toCallContext(verified.caller, {
      modelId: 'model-1',
      agentVersion: { id: 'version-1', number: 1, summary: '' },
    });
    expect(ctx.door).toEqual({ kind: 'run', agentId: AGENT, agentVersion: 1 });
    expect(await authorization.creator(ctx)).toMatchObject({ kind: 'agent', body });
  });

  it('admits a user agent whose token carries no person as reads-only', async () => {
    const s = setup();
    s.agentRows.set(AGENT, {});
    const token = await s.issue();
    expect(await verifyRunCaller(bearer(token), s.deps)).toMatchObject({
      ok: false,
      code: 'no_caller',
      reads: true,
    });
  });

  it('lets a Builder run through as before', async () => {
    const s = setup();
    const token = await s.issue(member);
    const verifyCaller = createBuilderCallerVerifier(s.deps);
    for (const method of ['initialize', 'tools/list']) {
      const response = await serveBuilderMcp(rpc(token, method), doorOf(verifyCaller));
      expect(response.status).toBe(200);
    }
  });
});
