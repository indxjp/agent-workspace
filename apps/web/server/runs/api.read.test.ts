import { afterEach, describe, expect, it } from 'vitest';
import { RunDetailResponseSchema, RunListResponseSchema } from '@indx-workspace/contracts/runs';
import { resetTestRunApi } from '../application-context-fixtures';
import { listRuns, readRun, revokeRunTokens, startRun } from './api';
import {
  AGENT,
  errorCode,
  get,
  install,
  newRunId,
  OTHER_WORKSPACE,
  post,
  PRINCIPAL,
  SESSION,
  WORKSPACE,
} from './api.test-support';
import { type RunPrincipal } from './environment';
import { InMemoryRunStore } from './memory-store';

afterEach(() => {
  resetTestRunApi();
});

const create = (store: InMemoryRunStore, id: string, workspaceId = WORKSPACE) =>
  store.create({ engine: 'claude-agent-sdk', id, workspaceId, agentId: AGENT, sessionId: id });
const readDetail = async (id: string) =>
  RunDetailResponseSchema.parse(await (await readRun(get(`http://web/api/runs/${id}`), id)).json())
    .run;
const OTHER_SESSION = '99999999-9999-4999-8999-999999999999';
function sessionScopedPrincipal(sessionId: string): RunPrincipal {
  return { ...PRINCIPAL, scope: { kind: 'session', id: sessionId } };
}
function runScopedPrincipal(runId: string): RunPrincipal {
  return { ...PRINCIPAL, scope: { kind: 'run', id: runId } };
}

describe('GET /api/runs/:id', () => {
  it('allows an own run and denies another member run under own-only grants', async () => {
    const harness = install({
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'viewer' }),
    });
    await harness.store.create({
      engine: 'claude-agent-sdk',
      id: SESSION,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
    });

    expect((await readRun(get(`http://web/api/runs/${SESSION}`), SESSION)).status).toBe(200);
    install({
      store: harness.store,
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'viewer' }),
      ownsRun: () => Promise.resolve(false),
    });
    expect((await readRun(get(`http://web/api/runs/${SESSION}`), SESSION)).status).toBe(403);
  });

  it('lets an Admin read another member’s run where a Viewer is refused — issue #165 widened Admin’s `runs` grant to `read: any`', async () => {
    const harness = install({
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'admin' }),
      ownsRun: () => Promise.resolve(false),
    });
    await harness.store.create({
      engine: 'claude-agent-sdk',
      id: SESSION,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
    });
    expect((await readRun(get(`http://web/api/runs/${SESSION}`), SESSION)).status).toBe(200);

    // The same run and the same `other` ownership answer, one role narrower: what changed is the
    // §21 grant, not anything this route does. See
    // docs/adr/W9-AUTH-165-admin-reads-workspace-run-history.md.
    install({
      store: harness.store,
      authenticate: () => Promise.resolve({ ...PRINCIPAL, role: 'viewer' }),
      ownsRun: () => Promise.resolve(false),
    });
    expect((await readRun(get(`http://web/api/runs/${SESSION}`), SESSION)).status).toBe(403);
  });
});

describe('GET /api/runs/:id', () => {
  it('returns the run', async () => {
    install();
    const created = (await (await startRun(post(AGENT, { prompt: 'hi' }), AGENT)).json()) as {
      run: { id: string };
    };
    const response = await readRun(get(`http://web/api/runs/${created.run.id}`), created.run.id);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { run: { id: string } };
    expect(body.run.id).toBe(created.run.id);
  });

  it('names the agent version the run executed, or null for a legacy session (issue #1571)', async () => {
    const harness = install();
    const legacy = newRunId();
    await harness.store.create({
      engine: 'claude-agent-sdk',
      id: SESSION,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
      agentVersion: 3,
    });
    await harness.store.create({
      engine: 'claude-agent-sdk',
      id: legacy,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: legacy,
    });
    const read = async (id: string): Promise<unknown> =>
      (
        (await (await readRun(get(`http://web/api/runs/${id}`), id)).json()) as {
          run: { agentVersion: unknown };
        }
      ).run.agentVersion;
    expect(await read(SESSION)).toBe(3);
    expect(await read(legacy)).toBeNull();
  });

  it('returns 401 unauthenticated, 400 for a non-UUID and 404 for an unknown run', async () => {
    install();
    expect((await readRun(get('http://web/api/runs/x', {}, false), 'x')).status).toBe(401);
    expect((await readRun(get('http://web/api/runs/x'), 'x')).status).toBe(400);
    expect((await readRun(get('http://web/api/runs/x'), SESSION)).status).toBe(404);
  });
});

describe('GET /api/runs/:id', () => {
  it('returns 404 for a run belonging to another workspace', async () => {
    const harness = install();
    await harness.store.create({
      engine: 'claude-agent-sdk',
      id: SESSION,
      workspaceId: OTHER_WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
    });
    const response = await readRun(get(`http://web/api/runs/${SESSION}`), SESSION);
    expect(response.status).toBe(404);
  });
});

describe('GET /api/runs/:id > run trees (ADR-0104 acceptance decision 7)', () => {
  it('answers an existing run with parentRunId null, no children and its own cost as treeCost', async () => {
    const harness = install();
    const solo = newRunId();
    await create(harness.store, solo);
    const run = await readDetail(solo);
    expect(run.parentRunId).toBeNull();
    expect(run.children).toEqual([]);
    expect(run.treeCost).toEqual({ amount: run.cost.amount, currency: 'USD' });
  });

  it('lists a seeded child, oldest first, and sums the tree cost exactly', async () => {
    let tick = 0;
    const harness = install(
      {},
      new InMemoryRunStore({ now: () => new Date(Date.UTC(2026, 9, 31, 0, 0, (tick += 1))) }),
    );
    const root = newRunId();
    const first = newRunId();
    const second = newRunId();
    const foreign = newRunId();
    await create(harness.store, root);
    await create(harness.store, first);
    await create(harness.store, second);
    await create(harness.store, foreign, OTHER_WORKSPACE);
    harness.store.seedChildForTests(first, root, '0.100000');
    harness.store.seedChildForTests(second, root, '0.200000');
    // Another workspace's run naming this root is not its child.
    harness.store.seedChildForTests(foreign, root, '5.000000');
    const run = await readDetail(root);
    expect(run.children?.map((child) => child.id)).toEqual([first, second]);
    expect(run.children?.every((child) => child.parentRunId === root)).toBe(true);
    expect(run.treeCost).toEqual({ amount: '0.300000', currency: 'USD' });
    const child = await readDetail(first);
    expect(child).toMatchObject({ parentRunId: root, children: [] });
    expect(child.treeCost?.amount).toBe('0.100000');
  });
});

describe('GET /api/runs/:id > run trees (ADR-0104 acceptance decision 7)', () => {
  it('keeps children and treeCost off the list, which still carries parentRunId', async () => {
    const harness = install();
    const root = newRunId();
    const child = newRunId();
    await create(harness.store, root);
    await create(harness.store, child);
    harness.store.seedChildForTests(child, root);
    const page = RunListResponseSchema.parse(
      await (await listRuns(get('http://web/api/runs'))).json(),
    );
    expect(page.runs.map((run) => [run.id, run.parentRunId]).sort()).toEqual(
      [
        [root, null],
        [child, root],
      ].sort(),
    );
    for (const run of page.runs) {
      expect(run).not.toHaveProperty('children');
      expect(run).not.toHaveProperty('treeCost');
    }
  });
});

/**
 * The row-identity half of a session-scoped browser token's grammar (issue #236, SDK-04, S-1).
 * `decide()`'s scope grammar (`rbac/decide.ts`) enforces which route *shapes* a scope may reach;
 * these are the checks that live in this file because the path alone cannot carry a session id to
 * compare against (`readRun`/`streamRunEvents`'s `:id` is a run, `startRun`'s is an agent).
 */
describe('a session-scoped browser token’s row identity (issue #236)', () => {
  it('readRun allows a run in the scoped session and refuses one in another', async () => {
    const harness = install({
      authenticate: () => Promise.resolve(sessionScopedPrincipal(SESSION)),
    });
    await harness.store.create({
      engine: 'claude-agent-sdk',
      id: SESSION,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
    });
    expect((await readRun(get(`http://web/api/runs/${SESSION}`), SESSION)).status).toBe(200);

    const otherRunId = '88888888-8888-4888-8888-888888888888';
    await harness.store.create({
      engine: 'claude-agent-sdk',
      id: otherRunId,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: OTHER_SESSION,
    });
    const response = await readRun(get(`http://web/api/runs/${otherRunId}`), otherRunId);
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('token_out_of_scope');
  });

  it('readRun allows a run-scoped token matching the run id, exactly as decide() would', async () => {
    // The row-identity check in this file is scope-kind specific: a run scope's `:id` match is
    // `decide()`'s own job (proved in `rbac/authorisation-matrix.test.ts`), so this file's guard
    // must not itself reject a run scope whose session happens to differ from anything.
    const harness = install({ authenticate: () => Promise.resolve(runScopedPrincipal(SESSION)) });
    await harness.store.create({
      engine: 'claude-agent-sdk',
      id: SESSION,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: OTHER_SESSION,
    });
    expect((await readRun(get(`http://web/api/runs/${SESSION}`), SESSION)).status).toBe(200);
  });
});

describe('a session-scoped browser token’s row identity (issue #236)', () => {
  it('startRun refuses a session-scoped token whose body omits sessionId or names another', async () => {
    install({ authenticate: () => Promise.resolve(sessionScopedPrincipal(SESSION)) });
    const omitted = await startRun(post(AGENT, { prompt: 'hello' }), AGENT);
    expect(omitted.status).toBe(403);
    expect(await errorCode(omitted)).toBe('token_out_of_scope');

    const mismatched = await startRun(
      post(AGENT, { prompt: 'hello', sessionId: OTHER_SESSION }),
      AGENT,
    );
    expect(mismatched.status).toBe(403);
    expect(await errorCode(mismatched)).toBe('token_out_of_scope');

    const matched = await startRun(post(AGENT, { prompt: 'hello', sessionId: SESSION }), AGENT);
    expect(matched.status).toBe(202);
  });

  it('revokeRunTokens refuses any browser-token principal outright, whatever its role', async () => {
    install({
      authenticate: () =>
        Promise.resolve({ ...sessionScopedPrincipal(SESSION), role: 'owner' as const }),
      revokeRunTokens: () => Promise.resolve({ revoked: 0, outcome: 'not-found' }),
    });
    const response = await revokeRunTokens(
      new Request(`http://web/api/runs/${SESSION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-user': '1' },
        body: JSON.stringify({}),
      }),
      SESSION,
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('token_out_of_scope');
  });
});
