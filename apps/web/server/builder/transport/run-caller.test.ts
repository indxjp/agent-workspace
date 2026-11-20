import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearFeatureSwitches } from '../../features/wiring';
import { conferredBy } from '../../rbac/core/conferral';
import { createMemoryDirectory } from '../../rbac/memory-directory';
import { log } from '../../telemetry/logger';
import { verifyRunCaller } from './run-caller';
import {
  bearer,
  MEMBER,
  MEMBER_CALLER,
  mcpPost,
  memberMembershipId,
  OTHER_WORKSPACE,
  RUN,
  RUN_IDENTITY,
  runRowIn,
  setup,
  SESSION,
  AGENT,
  START,
  WORKSPACE,
} from './run-caller.test-support';

afterEach(() => {
  vi.restoreAllMocks();
  clearFeatureSwitches();
});

describe('verifyRunCaller caller resolution', () => {
  it('a run token with no caller cannot use a write tool', async () => {
    const s = setup();
    const token = await s.issue();
    const result = await verifyRunCaller(bearer(token), s.deps, mcpPost());
    expect(result).toEqual({ ok: false, code: 'no_caller', reads: true, run: RUN_IDENTITY });
  });

  it('resolves a member to their current role, read from the directory on every call', async () => {
    const s = setup();
    const token = await s.issue(MEMBER_CALLER);
    expect(await verifyRunCaller(bearer(token), s.deps, mcpPost())).toEqual({
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
    await s.directory
      .forWorkspace(WORKSPACE)
      .changeMembershipRole(
        await memberMembershipId(s),
        conferredBy('owner', 'viewer', 'run-caller.test'),
      );
    const after = await verifyRunCaller(bearer(token), s.deps, mcpPost());
    expect(after.ok && after.caller.role).toBe('viewer');
  });

  it('refuses a removed member without reads', async () => {
    const s = setup();
    const token = await s.issue(MEMBER_CALLER);
    await s.directory.forWorkspace(WORKSPACE).deleteMembership(await memberMembershipId(s));
    expect(await verifyRunCaller(bearer(token), s.deps, mcpPost())).toEqual({
      ok: false,
      code: 'no_caller',
      reads: false,
    });
  });

  it('gives an api-key caller with a subject no write role, reads allowed', async () => {
    const s = setup();
    const token = await s.issue({ caller: { sub: 'customer-7', principalKind: 'api-key' } });
    expect(await verifyRunCaller(bearer(token), s.deps, mcpPost())).toEqual({
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
    expect(await verifyRunCaller(bearer(token), s.deps, mcpPost())).toEqual({
      ok: false,
      code: 'no_caller',
      reads: true,
      run: RUN_IDENTITY,
    });
  });

  it('refuses a membership caller whose membership is in another workspace than the token', async () => {
    const s = setup();
    s.runs.set(RUN, runRowIn(OTHER_WORKSPACE));
    const token = await s.issue({
      workspaceId: OTHER_WORKSPACE,
      caller: { sub: MEMBER, principalKind: 'membership' },
    });
    expect(await verifyRunCaller(bearer(token), s.deps, mcpPost())).toEqual({
      ok: false,
      code: 'no_caller',
      reads: false,
    });
  });

  it('never lets a visitor reach the control plane, reads included', async () => {
    const s = setup();
    const token = await s.issue({ caller: { sub: 'visitor-1', principalKind: 'visitor' } });
    expect(await verifyRunCaller(bearer(token), s.deps, mcpPost())).toEqual({
      ok: false,
      code: 'no_caller',
      reads: false,
    });
  });
});

describe('verifyRunCaller token failures are refused as not_permitted, without reads', () => {
  const refused = { ok: false, code: 'not_permitted', reads: false };

  it('an expired token (TTL 300 s, injected clock)', async () => {
    const s = setup();
    const token = await s.issue(MEMBER_CALLER);
    s.now.value = START + 299;
    expect((await verifyRunCaller(bearer(token), s.deps, mcpPost())).ok).toBe(true);
    s.now.value = START + 300;
    expect(await verifyRunCaller(bearer(token), s.deps, mcpPost())).toEqual(refused);
  });

  it('a revoked token', async () => {
    const s = setup();
    const token = await s.issue(MEMBER_CALLER);
    for (const row of s.registered.values()) row.revoked = true;
    expect(await verifyRunCaller(bearer(token), s.deps, mcpPost())).toEqual(refused);
  });

  it.each(['completed', 'awaiting_approval'] as const)(
    'a run that has stopped (%s)',
    async (status) => {
      const s = setup();
      const token = await s.issue(MEMBER_CALLER);
      const run = s.runs.get(RUN);
      if (run === undefined) throw new Error('fixture run missing');
      run.status = status;
      expect(await verifyRunCaller(bearer(token), s.deps, mcpPost())).toEqual(refused);
    },
  );

  it('a run in another workspace than the token names', async () => {
    const s = setup();
    s.runs.set(RUN, runRowIn(OTHER_WORKSPACE));
    const token = await s.issue(MEMBER_CALLER);
    expect(await verifyRunCaller(bearer(token), s.deps, mcpPost())).toEqual(refused);
  });

  it('a token registered for a different run id', async () => {
    const s = setup();
    const token = await s.issue(MEMBER_CALLER, { runId: 'run-2' });
    expect(await verifyRunCaller(bearer(token), s.deps, mcpPost())).toEqual(refused);
  });

  it('a token whose session or agent does not match the run row', async () => {
    const s = setup();
    const token = await s.issue({ ...MEMBER_CALLER, agentId: 'agent-2' });
    expect(await verifyRunCaller(bearer(token), s.deps, mcpPost())).toEqual(refused);
  });

  it.each([null, '', 'Bearer', 'Bearer not-a-token', 'Basic abc'])(
    'a missing or malformed bearer (%s)',
    async (authorization) => {
      const s = setup();
      expect(await verifyRunCaller(authorization, s.deps, mcpPost())).toEqual(refused);
    },
  );
});

describe('verifyRunCaller dependency failures are refused as not_permitted, without reads', () => {
  const refused = { ok: false, code: 'not_permitted', reads: false };

  it('a directory lookup that throws', async () => {
    const s = setup();
    const token = await s.issue(MEMBER_CALLER);
    expect(
      await verifyRunCaller(
        bearer(token),
        {
          ...s.deps,
          directory: {
            forWorkspace: () => {
              throw new Error('directory exploded');
            },
          },
        },
        mcpPost(),
      ),
    ).toEqual(refused);
  });

  it('a database lookup that rejects', async () => {
    const s = setup();
    const token = await s.issue(MEMBER_CALLER);
    expect(
      await verifyRunCaller(
        bearer(token),
        {
          ...s.deps,
          database: {
            ...s.database,
            scopes: { forWorkspaceId: () => Promise.reject(new Error('database exploded')) },
          },
        },
        mcpPost(),
      ),
    ).toEqual(refused);
  });
});

describe('verifyRunCaller failures and what it logs', () => {
  it('fails closed and logs only the error class when a dependency throws', async () => {
    const s = setup();
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const token = await s.issue(MEMBER_CALLER);
    class DirectoryUnavailableError extends Error {
      override name = 'DirectoryUnavailableError';
    }
    const result = await verifyRunCaller(
      bearer(token),
      {
        ...s.deps,
        directory: {
          forWorkspace: () => {
            throw new DirectoryUnavailableError(`select * from memberships where tok=${token}`);
          },
        },
      },
      mcpPost(),
    );
    expect(result).toEqual({ ok: false, code: 'not_permitted', reads: false });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]).toEqual([
      'builder run caller verification failed',
      { op: 'builder.transport', errorName: 'DirectoryUnavailableError' },
    ]);
    expect(JSON.stringify(error.mock.calls)).not.toContain(token);
    expect(JSON.stringify(error.mock.calls)).not.toContain('memberships');
  });

  it('does not log a refusal that is an answer rather than a failure', async () => {
    const s = setup();
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const token = await s.issue({
      caller: { sub: 'someone-removed', principalKind: 'membership' },
    });
    expect(await verifyRunCaller(bearer(token), s.deps, mcpPost())).toMatchObject({
      code: 'no_caller',
    });
    expect(await verifyRunCaller('Bearer nonsense', s.deps, mcpPost())).toMatchObject({
      code: 'not_permitted',
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('looks the caller up by principal and never reads the member list', async () => {
    const s = setup();
    const token = await s.issue(MEMBER_CALLER);
    const workspace = s.directory.forWorkspace(WORKSPACE);
    const list = vi.fn(() => Promise.reject(new Error('the member list must not be scanned')));
    const find = vi.spyOn(workspace, 'findMembershipByPrincipal');
    const result = await verifyRunCaller(
      bearer(token),
      {
        ...s.deps,
        directory: { forWorkspace: () => ({ ...workspace, listMemberships: list }) },
      },
      mcpPost(),
    );
    expect(result).toMatchObject({ ok: true, caller: { principalId: MEMBER, role: 'builder' } });
    expect(find).toHaveBeenCalledExactlyOnceWith(MEMBER);
    expect(list).not.toHaveBeenCalled();
  });

  it('puts no token, subject or error text in a result or a log line', async () => {
    const s = setup();
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');
    const token = await s.issue(MEMBER_CALLER);
    const results = [
      await verifyRunCaller(
        bearer(token),
        {
          ...s.deps,
          directory: {
            forWorkspace: () => {
              throw new Error(`leaky ${token}`);
            },
          },
        },
        mcpPost(),
      ),
      await verifyRunCaller(
        bearer(token),
        {
          ...s.deps,
          directory: createMemoryDirectory(),
        },
        mcpPost(),
      ),
    ];
    const seen = JSON.stringify(results) + JSON.stringify([...out.mock.calls, ...err.mock.calls]);
    expect(seen).not.toContain(token);
    expect(seen).not.toContain(MEMBER);
    expect(seen).not.toContain('leaky');
  });
});
