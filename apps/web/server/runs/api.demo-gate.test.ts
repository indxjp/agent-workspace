import type { DemoRunStartProblemCode } from '@indx-workspace/contracts/demo';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetTestRunApi } from '../application-context-fixtures';
import { decide, install as installApproval, pausedRun } from './approval.test-support';
import { startRun } from './api';
import { AGENT, errorCode, install, post, SESSION, WORKSPACE } from './api.test-support';
import type { DemoRunGate } from './demo-run-gate';
import { startRunOnSession } from './service';
import { AGENT as TEAM_AGENT, PRINCIPAL, START, harness } from './service.test-support';

afterEach(() => {
  resetTestRunApi();
});

const refusing = (code: DemoRunStartProblemCode): DemoRunGate => ({
  refusal: () => Promise.resolve({ code }),
});

describe('a run start in a demo workspace meets the demo caps last', () => {
  it.each([
    ['demo_person_runs_reached', 429],
    ['demo_client_runs_reached', 429],
    ['demo_site_cost_reached', 429],
    ['demo_caps_unconfigured', 503],
    ['demo_expired', 409],
  ] as const)('refuses %s with %i, starts no run and leaves no session', async (code, status) => {
    const discarded: string[] = [];
    const harness = install({
      demoRunGate: refusing(code),
      discardSession: (_principal, sessionId) => {
        discarded.push(sessionId);
        return Promise.resolve();
      },
    });
    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(response.status).toBe(status);
    expect(await errorCode(response)).toBe(code);
    expect((await harness.store.listRuns(WORKSPACE, { limit: 10 })).items).toHaveLength(0);
    expect(harness.launched).toHaveLength(0);
    expect(discarded).toEqual([SESSION]);
  });

  it('says nothing about an amount or an internal detail', async () => {
    install({ demoRunGate: refusing('demo_site_cost_reached') });
    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    const body = JSON.stringify(await response.json());
    expect(body).not.toMatch(/usd|\$|cost cap|[0-9]{2,}/iu);
  });

  it('starts the run when the gate lets it through, passing the workspace, the person and the client headers', async () => {
    const refusal = vi.fn(() => Promise.resolve(null));
    const harness = install({ demoRunGate: { refusal } });
    const response = await startRun(
      new Request(`http://web/api/agents/${AGENT}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user': '1', 'x-probe': 'seen' },
        body: JSON.stringify({ prompt: 'hi' }),
      }),
      AGENT,
    );
    expect(response.status).toBe(202);
    expect(harness.launched).toHaveLength(1);
    const call = refusal.mock.calls[0] as unknown as [
      {
        workspaceId: string;
        userId: string | null;
        clientHeaders: Headers | null;
        newRun: boolean;
      },
    ];
    expect(call[0].workspaceId).toBe(WORKSPACE);
    expect(call[0].userId).toEqual(expect.any(String));
    expect(call[0].clientHeaders?.get('x-probe')).toBe('seen');
    expect(call[0].newRun).toBe(true);
  });

  it('fails closed as unavailable when the caps cannot be read, without leaking the error', async () => {
    const harness = install({
      demoRunGate: {
        refusal: () => Promise.reject(new Error('relation demo_run_admissions broke')),
      },
    });
    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain('demo_caps_unconfigured');
    expect(text).not.toContain('demo_run_admissions');
    expect(harness.launched).toHaveLength(0);
  });

  it('is not consulted when a refusal earlier in the start already stopped it', async () => {
    const refusal = vi.fn(() => Promise.resolve(null));
    install({
      demoRunGate: { refusal },
      preflight: () =>
        Promise.resolve({ code: 'agent_runtime_profile_missing', message: 'no runtime profile.' }),
    });
    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(response.status).toBe(422);
    expect(refusal).not.toHaveBeenCalled();
  });

  it('gates nothing where no demo is installed', async () => {
    const harness = install();
    const response = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(response.status).toBe(202);
    expect(harness.launched).toHaveLength(1);
  });
});

describe('a continuation of a demo run is not a new demo run', () => {
  it('lets a visitor at the person cap approve a pending write: the gate is told it is not a new run', async () => {
    // A gate that, like the real one, refuses only a new run (the person is at the cap).
    const refusal = vi.fn((start: { readonly newRun: boolean }) =>
      Promise.resolve(start.newRun ? { code: 'demo_person_runs_reached' as const } : null),
    );
    const { store, launched } = installApproval({ demoRunGate: { refusal } });
    const paused = await pausedRun(store);
    const response = await decide(paused.id, 'approve');
    expect(response.status).toBe(202);
    expect(launched).toHaveLength(1);
    expect(refusal).toHaveBeenCalledTimes(1);
    expect(refusal.mock.calls[0]?.[0].newRun).toBe(false);
  });

  it('still meets the site cost: a continuation the gate refuses starts nothing', async () => {
    const { store, launched } = installApproval({
      demoRunGate: refusing('demo_site_cost_reached'),
    });
    const paused = await pausedRun(store);
    expect((await decide(paused.id, 'approve')).status).toBe(429);
    expect(launched).toHaveLength(0);
  });

  it('tells the gate a team child run is not a new run, and a plain start is', async () => {
    const refusal = vi.fn(() => Promise.resolve(null));
    const { env, store } = harness();
    const gated = { ...env, demoRunGate: { refusal } };
    const lead = await startRunOnSession(gated, PRINCIPAL, TEAM_AGENT, START);
    if (lead.kind !== 'started') throw new Error(lead.code);
    expect(await store.markRunning(lead.run.id)).toBe(true);
    const child = await startRunOnSession(gated, PRINCIPAL, TEAM_AGENT, {
      ...START,
      parent: { runId: lead.run.id, maxChildren: 16 },
    });
    expect(child.kind).toBe('started');
    const flags = (refusal.mock.calls as unknown as [{ newRun: boolean }][]).map(
      ([start]) => start.newRun,
    );
    expect(flags).toEqual([true, false]);
  });
});
