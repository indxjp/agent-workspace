import { afterEach, describe, expect, it } from 'vitest';

import { interruptRun } from './api';
import { decideRunApproval } from './approval';
import {
  CALL,
  OTHER_WORKSPACE,
  PRINCIPAL,
  SESSION,
  WORKSPACE,
  AGENT,
  decide,
  decision,
  errorCode,
  install,
  newRun,
  pausedRun,
} from './approval.test-support';
import { type RunPrincipal } from './environment';
import { InMemoryRunStore } from './memory-store';
import { resetTestRunApi } from '../application-context-fixtures';

afterEach(() => {
  resetTestRunApi();
});

describe('POST /api/runs/:id/approval: what is refused before a continuation starts', () => {
  it('answers 503, 401, 400 and 404 before it reads the body', async () => {
    const id = crypto.randomUUID();
    expect((await decideRunApproval(decision(id, {}), id)).status).toBe(503);
    install();
    expect((await decideRunApproval(decision(id, {}, false), id)).status).toBe(401);
    expect((await decideRunApproval(decision('x', {}), 'x')).status).toBe(400);
    expect((await decideRunApproval(decision(id, {}), id)).status).toBe(404);
  });

  it('conceals a foreign-workspace run behind the same 404 as a missing one', async () => {
    const { store } = install();
    const run = await pausedRun(store, { workspaceId: OTHER_WORKSPACE });
    expect((await decide(run.id, 'approve')).status).toBe(404);
  });

  it('refuses a second decision: the first one completed the paused run', async () => {
    const { store, launched } = install();
    const paused = await pausedRun(store);
    expect((await decide(paused.id, 'approve')).status).toBe(202);
    const second = await decide(paused.id, 'reject');
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe('run_not_awaiting_approval');
    expect(launched).toHaveLength(1);
  });

  it('refuses a run that is not paused', async () => {
    const { store } = install();
    const run = await store.create(newRun());
    const response = await decide(run.id, 'approve');
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('run_not_awaiting_approval');
  });

  it.each([
    ['an unknown decision', { decision: 'maybe' }],
    ['no decision', {}],
    ['an unknown key', { decision: 'approve', extra: true }],
    ['a blank comment', { decision: 'approve', comment: '   ' }],
  ])('refuses %s with 400 invalid_body and starts nothing', async (_name, body) => {
    const { store, launched } = install();
    const paused = await pausedRun(store);
    const response = await decideRunApproval(decision(paused.id, body), paused.id);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_body');
    expect(launched).toHaveLength(0);
    expect((await store.get(paused.id))?.status).toBe('awaiting_approval');
  });
});

describe('POST /api/runs/:id/approval: who may decide (ADR-0145 D2)', () => {
  it('refuses a member who may not run this row, before the body is read', async () => {
    const { store, launched } = install({
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'viewer' }),
      ownsRun: () => Promise.resolve(false),
    });
    const paused = await pausedRun(store);
    expect((await decide(paused.id, 'approve')).status).toBe(403);
    expect(launched).toHaveLength(0);
    expect((await store.get(paused.id))?.status).toBe('awaiting_approval');
  });
});

describe('POST /api/runs/:id/approval: scoped credentials (ADR-0161, ADR-0104)', () => {
  it('lets an app backend decide a run of a bound agent, and refuses one of an agent it does not bind (ADR-0161, issue #1509)', async () => {
    const appBackend = (agentIds: readonly string[]): RunPrincipal => ({
      ...PRINCIPAL,
      scope: { kind: 'app-backend', id: 'client-1', agentIds },
    });
    const refused = install({ authenticate: () => Promise.resolve(appBackend([SESSION])) });
    const other = await pausedRun(refused.store);
    const response = await decide(other.id, 'approve');
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('token_out_of_scope');
    expect(refused.launched).toHaveLength(0);
    expect((await refused.store.get(other.id))?.status).toBe('awaiting_approval');

    const admitted = install({
      authenticate: () => Promise.resolve(appBackend([AGENT.toUpperCase()])),
    });
    const bound = await pausedRun(admitted.store);
    expect((await decide(bound.id, 'approve')).status).toBe(202);
    expect(admitted.launched).toHaveLength(1);
  });

  it("refuses a scoped credential's decision on a team lead run, so its member calls never act for an unattenuated role (ADR-0104)", async () => {
    const sessionScoped: RunPrincipal = {
      ...PRINCIPAL,
      via: 'session',
      kind: 'membership',
      scope: { kind: 'session', id: SESSION },
    };
    let caller = sessionScoped;
    const { store, launched } = install({ authenticate: () => Promise.resolve(caller) });
    const lead = crypto.randomUUID();
    await store.create({
      ...newRun(WORKSPACE, lead),
      agentTeamVersionId: '99999999-9999-4999-8999-999999999999',
    });
    await store.markRunning(lead);
    await store.awaitApproval(lead, CALL);
    const response = await decide(lead, 'approve');
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('token_out_of_scope');
    expect(launched).toHaveLength(0);
    expect((await store.get(lead))?.status).toBe('awaiting_approval');

    // The person's own unscoped credential decides it.
    caller = { ...sessionScoped, scope: null };
    expect((await decide(lead, 'approve')).status).toBe(202);
    expect(launched).toHaveLength(1);
  });
});

describe('POST /api/runs/:id/approval: interrupt', () => {
  it('an interrupt of a paused run cancels it, and a decision after it is 409', async () => {
    const store = new InMemoryRunStore();
    const { launched } = install(
      {
        interruptRun: async (_principal, run) => {
          await store.finish(run.id, 'cancelled', 'the run was interrupted by request', true);
        },
      },
      store,
    );
    const paused = await pausedRun(store);
    const request = new Request(`http://web/api/runs/${paused.id}/interrupt`, {
      method: 'POST',
      headers: { 'x-test-user': '1' },
    });
    expect((await interruptRun(request, paused.id)).status).toBe(200);
    expect((await store.get(paused.id))?.status).toBe('cancelled');

    expect((await decide(paused.id, 'approve')).status).toBe(409);
    expect(launched).toHaveLength(0);
  });
});
