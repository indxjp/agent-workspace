/**
 * The store's claim: every demo run is recorded with the person who asked, the agent, the time and
 * the outcome. A run a guest starts in a demo workspace is a row in the run history that workspace
 * reads, attributed to the guest, and the guest reads it back as its own and nobody else's.
 *
 * The runs domain is not changed for the store; this test drives its public routes with a guest
 * principal and the demo gate in place, so what it proves is what a visitor's run gets.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { installTestDomains, resetTestRunApi } from '../../application-context-fixtures';
import { listRuns, readRun, startRun } from '../../runs/api';
import {
  AGENT,
  get,
  install,
  listBody,
  post,
  SESSION,
  WORKSPACE,
} from '../../runs/api.test-support';
import type { RunPrincipal } from '../../runs/environment';
import { InMemoryRunStore } from '../../runs/memory-store';
import type { DemoRunGate } from '../../runs/demo-run-gate';

afterEach(() => {
  resetTestRunApi();
});

const NOW = new Date('2026-11-16T03:00:00.000Z');
const DEMO_WORKSPACE = WORKSPACE;

const guest = (n: number): RunPrincipal => ({
  principalId: `00000000-0000-4000-8000-00000000010${n}`,
  ownerPrincipalId: `00000000-0000-4000-8000-00000000010${n}`,
  userId: `00000000-0000-4000-8000-00000000020${n}`,
  workspaceId: DEMO_WORKSPACE,
  role: 'guest',
  scope: null,
});

/** A demo workspace's gate, with every cap clear: the run is admitted. */
const admitting: DemoRunGate = { refusal: () => Promise.resolve(null) };

/** The agent the provisioner copied and granted to the guests, and one it did not. */
const GRANTED_AGENT = AGENT;
const UNGRANTED_AGENT = '99999999-9999-4999-8999-999999999999';
const TEMPLATE_OWNER = '00000000-0000-4000-8000-000000000999';

/**
 * A visitor's demo workspace: its agents are owned by the deployment, and the provisioner's grant
 * (`agent_grants`) names the guests on the one agent they may run.
 */
function demoWorkspace(visitor: () => RunPrincipal) {
  const store = new InMemoryRunStore({ now: () => NOW });
  const known = new Set([GRANTED_AGENT, UNGRANTED_AGENT]);
  installTestDomains({
    agents: {
      agents: {
        forWorkspace: () => ({
          get: (id: string) =>
            Promise.resolve(known.has(id) ? { id, ownerPrincipalId: TEMPLATE_OWNER } : null),
        }),
      } as never,
      agentGrants: {
        forWorkspace: () => ({
          hasGrant: (agentId: string) => Promise.resolve(agentId === GRANTED_AGENT),
        }),
      } as never,
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: DEMO_WORKSPACE }),
    },
  });
  install(
    {
      // The deployment's rule: a run is its person's when the session that holds it is.
      ownsRun: (principal, run) =>
        Promise.resolve(run.ownerPrincipalId === principal.ownerPrincipalId),
      findAgent: (principal, id) =>
        Promise.resolve(
          known.has(id)
            ? { id, workspaceId: principal.workspaceId, engine: 'claude-agent-sdk' }
            : null,
        ),
      authenticate: (request: Request) =>
        Promise.resolve(request.headers.get('x-test-user') === null ? null : visitor()),
      demoRunGate: admitting,
    },
    store,
  );
  return store;
}

describe('a demo run is recorded', () => {
  it('is in the run history with the guest who asked, the agent, the time and its outcome', async () => {
    const store = demoWorkspace(() => guest(1));
    const started = await startRun(post(AGENT, { prompt: 'Which deals are stuck?' }), AGENT);
    expect(started.status).toBe(202);
    const { run } = (await started.json()) as { run: { id: string } };

    // The outcome: the run finishes and its record says so.
    expect(await store.markRunning(run.id)).toBe(true);
    await store.finish(run.id, 'completed', null);

    const listed = await listBody(await listRuns(get('http://web/api/runs')));
    expect(listed.runs).toHaveLength(1);
    expect(listed.runs[0]).toMatchObject({
      id: run.id,
      workspaceId: DEMO_WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
      initiatingUserId: guest(1).userId,
      status: 'completed',
      createdAt: NOW.toISOString(),
      endedAt: NOW.toISOString(),
      error: null,
    });

    expect(listed.runs[0]?.['cost']).toMatchObject({ currency: 'USD' });

    // The same record, read by id, names the same person and agent.
    const detail = (await (await readRun(get(`http://web/api/runs/${run.id}`), run.id)).json()) as {
      run: { initiatingUserId: string; agentId: string; status: string };
    };
    expect(detail.run).toMatchObject({
      initiatingUserId: guest(1).userId,
      agentId: AGENT,
      status: 'completed',
    });
  });

  it('records a run that fails with its outcome, not only the ones that succeed', async () => {
    const store = demoWorkspace(() => guest(1));
    const started = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    const { run } = (await started.json()) as { run: { id: string } };
    await store.markRunning(run.id);
    await store.finish(run.id, 'failed', 'the model was unavailable');

    const listed = await listBody(await listRuns(get('http://web/api/runs')));
    expect(listed.runs).toHaveLength(1);
    expect(listed.runs[0]).toMatchObject({ id: run.id, status: 'failed' });
  });

  it('records a run the demo caps refuse as no run at all, so the history holds only runs that happened', async () => {
    const store = new InMemoryRunStore({ now: () => NOW });
    install(
      {
        authenticate: () => Promise.resolve(guest(1)),
        demoRunGate: { refusal: () => Promise.resolve({ code: 'demo_person_runs_reached' }) },
      },
      store,
    );
    const refused = await startRun(post(AGENT, { prompt: 'hi' }), AGENT);
    expect(refused.status).toBe(429);
    expect((await store.listRuns(DEMO_WORKSPACE, { limit: 10 })).items).toEqual([]);
  });

  it('shows a guest its own runs only: a second guest in the same workspace does not see them', async () => {
    let current = guest(1);
    demoWorkspace(() => current);
    await startRun(post(AGENT, { prompt: 'mine' }), AGENT);

    current = guest(2);
    const other = await listBody(await listRuns(get('http://web/api/runs')));
    expect(other.runs).toEqual([]);

    current = guest(1);
    const mine = await listBody(await listRuns(get('http://web/api/runs')));
    expect(mine.runs).toHaveLength(1);
    expect(mine.runs[0]).toMatchObject({ initiatingUserId: guest(1).userId });
  });

  it('acts as the guest and no further: an agent the guest was not granted is refused and starts no run', async () => {
    const store = demoWorkspace(() => guest(1));
    const refused = await startRun(post(UNGRANTED_AGENT, { prompt: 'hi' }), UNGRANTED_AGENT);
    expect(refused.status).toBe(403);
    expect((await store.listRuns(DEMO_WORKSPACE, { limit: 10 })).items).toEqual([]);

    const allowed = await startRun(post(GRANTED_AGENT, { prompt: 'hi' }), GRANTED_AGENT);
    expect(allowed.status).toBe(202);
    expect((await store.listRuns(DEMO_WORKSPACE, { limit: 10 })).items[0]).toMatchObject({
      initiatingUserId: guest(1).userId,
      ownerPrincipalId: guest(1).principalId,
    });
  });

  it("does not let a guest read another guest's run by id", async () => {
    let current = guest(1);
    demoWorkspace(() => current);
    const started = await startRun(post(AGENT, { prompt: 'mine' }), AGENT);
    const { run } = (await started.json()) as { run: { id: string } };

    current = guest(2);
    const read = await readRun(get(`http://web/api/runs/${run.id}`), run.id);
    expect(read.status).toBe(403);
  });
});
