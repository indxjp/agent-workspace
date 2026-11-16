import { RunApprovalResponseSchema } from '@indx-workspace/contracts/runs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CALL,
  PRINCIPAL,
  SESSION,
  decide,
  errorCode,
  install,
  patchRunOnRead,
  pausedRun,
} from './approval.test-support';
import { type AgentRef, type RunPrincipal, type SessionRef } from './environment';
import { resetTestRunApi } from '../application-context-fixtures';

afterEach(() => {
  resetTestRunApi();
});

describe('POST /api/runs/:id/approval: the continuation a decision starts (ADR-0145 D2)', () => {
  it('approve answers 202 with a queued continuation in the same session that may make the call', async () => {
    const { store, launched } = install();
    const paused = await pausedRun(store);
    const response = await decide(paused.id, 'approve', { comment: 'go ahead' });
    expect(response.status).toBe(202);
    const body = RunApprovalResponseSchema.parse(await response.json());
    expect(body.run.id).not.toBe(paused.id);
    expect(body.run.sessionId).toBe(SESSION);
    expect(body.events).toBe(`/api/runs/${body.run.id}/events`);
    expect(response.headers.get('Location')).toBe(body.events);

    expect((await store.get(paused.id))?.status).toBe('completed');
    // The repository store writes the same event; a replay of the paused run ends `completed`.
    const handle = await store.openStream(paused.id, null);
    if (handle === null) throw new Error('the paused run had no event stream');
    const statuses: unknown[] = [];
    for await (const event of handle.events) {
      if (event.type === 'run.status') statuses.push(event.data);
    }
    expect(statuses.at(-1)).toEqual({ status: 'completed', error: null });
    expect(launched).toHaveLength(1);
    expect(launched[0]?.prompt).toBe('approved: go ahead');
    expect(launched[0]?.run.approvedToolCalls).toEqual([CALL]);
  });

  it('reject starts a continuation that may not make the call', async () => {
    const { store, launched } = install();
    const paused = await pausedRun(store);
    expect((await decide(paused.id, 'reject')).status).toBe(202);
    expect(launched[0]?.prompt).toBe('rejected');
    expect(launched[0]?.run.approvedToolCalls).toEqual([]);
    expect((await store.get(paused.id))?.status).toBe('completed');
  });

  it("an Admin deciding another member's run continues it on the session owner's principal (ADR-0145 D2.2)", async () => {
    const OWNER = '88888888-8888-4888-8888-888888888888';
    const admin: RunPrincipal = { ...PRINCIPAL, role: 'admin' };
    // The real wiring's rule (`openRunSession`): only the session's owner opens it.
    const { store, launched } = install({
      authenticate: () => Promise.resolve(admin),
      ownsRun: () => Promise.resolve(false),
      openSession: (p: RunPrincipal, agent: AgentRef): Promise<SessionRef | null> =>
        Promise.resolve(
          p.ownerPrincipalId === OWNER ? { id: SESSION, agentId: agent.id, engine: null } : null,
        ),
    });
    const paused = await pausedRun(store);
    patchRunOnRead(store, paused.id, { ownerPrincipalId: OWNER });
    expect((await decide(paused.id, 'approve')).status).toBe(202);
    expect(launched[0]?.principal.ownerPrincipalId).toBe(OWNER);
    expect(launched[0]?.principal.principalId).toBe(admin.principalId);
    expect(launched[0]?.session.id).toBe(SESSION);
  });
});

describe('POST /api/runs/:id/approval: what a continuation inherits', () => {
  it("inherits the paused run's file grants as its scope (issue #1539)", async () => {
    const { store, launched } = install();
    const paused = await pausedRun(store);
    patchRunOnRead(store, paused.id, { fileGrants: ['docs/alice'] });
    expect((await decide(paused.id, 'approve')).status).toBe(202);
    expect(launched[0]?.fileScope).toEqual(['docs/alice']);
  });

  it("drops the paused run's attachment paths from its file scope", async () => {
    const { store, launched } = install();
    const paused = await pausedRun(store);
    patchRunOnRead(store, paused.id, {
      fileGrants: ['docs/alice', `.attachments/${SESSION}/x.pdf`, '.Attachments/y.txt'],
    });
    expect((await decide(paused.id, 'approve')).status).toBe(202);
    expect(launched[0]?.fileScope).toEqual(['docs/alice']);
  });

  it('carries no scope, schema, subject or cap when the paused run had none', async () => {
    const { store, launched } = install();
    const paused = await pausedRun(store);
    await decide(paused.id, 'approve');
    expect(launched[0]?.fileScope).toBeUndefined();
    expect(launched[0]?.outputSchema).toBeUndefined();
    expect(launched[0]?.subject).toBeUndefined();
    expect(launched[0]?.limits).toBeUndefined();
    expect(launched[0]?.run.limitsOverride).toBeNull();
  });

  it("approve and reject start a continuation that asks for the paused run's outputSchema", async () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    const { store, launched } = install();
    const approved = await pausedRun(store, { outputSchema: schema });
    await decide(approved.id, 'approve');
    expect(launched[0]?.outputSchema).toEqual(schema);
    expect(launched[0]?.run.outputSchema).toEqual(schema);
    const rejected = await pausedRun(store, { outputSchema: schema });
    await decide(rejected.id, 'reject');
    expect(launched[1]?.outputSchema).toEqual(schema);
  });
});

describe('POST /api/runs/:id/approval: the subject and the cap a continuation keeps', () => {
  it('the continuation of a subject-bearing run carries the same subject (ADR-0157)', async () => {
    const { store, launched } = install();
    const approved = await pausedRun(store, { subject: 'user-4711' });
    await decide(approved.id, 'approve');
    expect(launched[0]?.subject).toBe('user-4711');
    const rejected = await pausedRun(store, { subject: 'user-4711' });
    await decide(rejected.id, 'reject');
    expect(launched[1]?.subject).toBe('user-4711');
  });

  it("an approver's body cannot set the subject (400 invalid_body), and a member approving a key's run still acts for the stored subject", async () => {
    const { store, launched } = install();
    const paused = await pausedRun(store, { subject: 'user-4711' });
    const forged = await decide(paused.id, 'approve', { subject: 'someone-else' });
    expect(forged.status).toBe(400);
    expect(await errorCode(forged)).toBe('invalid_body');
    expect(launched).toHaveLength(0);
    expect((await store.get(paused.id))?.status).toBe('awaiting_approval');

    // PRINCIPAL is a signed-in member, not the key that started the run.
    expect((await decide(paused.id, 'approve')).status).toBe(202);
    expect(launched[0]?.subject).toBe('user-4711');
  });

  it('the continuation of a run started under a lower-only cap keeps the cap (#1963, SPD-01)', async () => {
    const { store, launched } = install();
    const approved = await pausedRun(store, {
      limitsOverride: { maxBudgetUsd: 0.3, maxTurns: 4 },
    });
    await decide(approved.id, 'approve');
    expect(launched[0]?.limits).toEqual({ maxBudgetUsd: 0.3, maxTurns: 4 });
    // The cap is on the continuation's own row too, so a second pause carries it on again.
    expect(launched[0]?.run.limitsOverride).toEqual({ maxBudgetUsd: 0.3, maxTurns: 4 });
    const rejected = await pausedRun(store, { limitsOverride: { maxBudgetUsd: 0.3 } });
    await decide(rejected.id, 'reject');
    expect(launched[1]?.limits).toEqual({ maxBudgetUsd: 0.3 });
  });
});
