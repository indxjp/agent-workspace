import { afterEach, describe, expect, it } from 'vitest';
import { InterruptRunResponseSchema } from '@indx-workspace/contracts/runs';
import { resetTestRunApi } from '../application-context-fixtures';
import { interruptRun, interruptRunFor } from './api';
import {
  errorCode,
  install,
  interruptRequest,
  newRunId,
  OTHER_WORKSPACE,
  PRINCIPAL,
  seedRun,
} from './api.test-support';
import { getRunApi } from './environment';
import { InMemoryRunStore } from './memory-store';
import { runStatuses } from './store';

afterEach(() => {
  resetTestRunApi();
});

describe('POST /api/runs/:id/interrupt (issue #235, S-14)', () => {
  it('answers 503 when the environment has no interruptRun implementation', async () => {
    install(); // the default harness in this file installs no interruptRun
    const run = await seedRun(new InMemoryRunStore());
    expect((await interruptRun(interruptRequest(run.id), run.id)).status).toBe(503);
  });

  it('returns 401 unauthenticated, 400 for a non-UUID, and 404 for an unknown run', async () => {
    install({ interruptRun: () => Promise.resolve() });
    expect((await interruptRun(interruptRequest('x', false), 'x')).status).toBe(401);
    expect((await interruptRun(interruptRequest('x'), 'x')).status).toBe(400);
    expect((await interruptRun(interruptRequest(newRunId()), newRunId())).status).toBe(404);
  });

  it('conceals a foreign-workspace run behind the same 404 as a nonexistent one (§25)', async () => {
    const harness = install({ interruptRun: () => Promise.resolve() });
    const run = await seedRun(harness.store, { workspaceId: OTHER_WORKSPACE });
    expect((await interruptRun(interruptRequest(run.id), run.id)).status).toBe(404);
  });

  it('the state matrix: queued, running and paused are interruptible; every terminal status is 409', async () => {
    for (const status of runStatuses) {
      const store = new InMemoryRunStore();
      let calls = 0;
      install(
        {
          interruptRun: () => {
            calls += 1;
            return Promise.resolve();
          },
        },
        store,
      );
      const run = await seedRun(store);
      if (status !== 'queued') {
        if (status === 'running' || status === 'awaiting_approval') await store.markRunning(run.id);
        if (status === 'awaiting_approval') {
          await store.awaitApproval(run.id, { toolName: 'send_email', canonicalCall: '{}' });
        } else if (status !== 'running') await store.finish(run.id, status, null);
      }
      const response = await interruptRun(interruptRequest(run.id), run.id);
      if (status === 'queued' || status === 'running' || status === 'awaiting_approval') {
        expect(response.status, status).toBe(200);
        expect(calls, status).toBe(1);
      } else {
        expect(response.status, status).toBe(409);
        expect(await errorCode(response), status).toBe('run_not_interruptible');
        expect(calls, status).toBe(0);
      }
    }
  });
});

describe('POST /api/runs/:id/interrupt (issue #235, S-14)', () => {
  it('interruptRunFor hands a live run to the runtime and reports a finished one as terminal', async () => {
    const store = new InMemoryRunStore();
    const stopped: string[] = [];
    install(
      {
        interruptRun: (_principal, run) => {
          stopped.push(run.id);
          return Promise.resolve();
        },
      },
      store,
    );
    const env = getRunApi();
    if (env === null) throw new Error('harness installs the run API');
    const live = await seedRun(store);
    const done = await seedRun(store);
    await store.finish(done.id, 'completed', null);
    expect(await interruptRunFor(env, PRINCIPAL, live)).toBe('stopped');
    expect(await interruptRunFor(env, PRINCIPAL, (await store.get(done.id)) ?? done)).toBe(
      'terminal',
    );
    expect(stopped).toEqual([live.id]);
  });

  it('a second interrupt of the same run answers 409', async () => {
    const store = new InMemoryRunStore();
    install(
      {
        interruptRun: async (_principal, run) => {
          await store.finish(run.id, 'cancelled', 'interrupted');
        },
      },
      store,
    );
    const run = await seedRun(store);
    expect((await interruptRun(interruptRequest(run.id), run.id)).status).toBe(200);
    const second = await interruptRun(interruptRequest(run.id), run.id);
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe('run_not_interruptible');
  });
});

describe('POST /api/runs/:id/interrupt (issue #235, S-14)', () => {
  it('responds with the run and its new status, parseable as InterruptRunResponseSchema', async () => {
    const store = new InMemoryRunStore();
    install(
      {
        interruptRun: async (_principal, run) => {
          await store.finish(run.id, 'cancelled', 'interrupted by request');
        },
      },
      store,
    );
    const run = await seedRun(store);
    const response = await interruptRun(interruptRequest(run.id), run.id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { run: { id: string; status: string } };
    expect(body.run.id).toBe(run.id);
    expect(body.run.status).toBe('cancelled');
    // The title's claim, asserted: `.strict()`, so a stray key on the envelope fails here rather
    // than in the SDK, which parses this response for real.
    expect(InterruptRunResponseSchema.safeParse(body).success).toBe(true);
  });

  it('the role matrix: Owner and Admin may interrupt any run; Builder and Viewer only their own', async () => {
    for (const role of ['owner', 'admin', 'builder', 'viewer'] as const) {
      for (const ownership of ['own', 'other'] as const) {
        const store = new InMemoryRunStore();
        install(
          {
            authenticate: () => Promise.resolve({ ...PRINCIPAL, role }),
            ownsRun: () => Promise.resolve(ownership === 'own'),
            interruptRun: () => Promise.resolve(),
          },
          store,
        );
        const run = await seedRun(store);
        const response = await interruptRun(interruptRequest(run.id), run.id);
        const allowed = role === 'owner' || role === 'admin' || ownership === 'own';
        expect(response.status, `${role} × ${ownership}`).toBe(allowed ? 200 : 403);
      }
    }
  });
});
