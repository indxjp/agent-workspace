import { afterEach, describe, expect, it } from 'vitest';
import { resetTestRunApi } from '../application-context-fixtures';
import { listRuns, readRun, renderRun } from './api';
import {
  AGENT,
  errorCode,
  get,
  install,
  listBody,
  newRunId,
  PRINCIPAL,
  seedRun,
  SESSION,
  WORKSPACE,
} from './api.test-support';
import { type RunPrincipal } from './environment';
import { InMemoryRunStore } from './memory-store';
import { type RunRecord } from './store';

afterEach(() => {
  resetTestRunApi();
});

async function expectRefused(query: string, code?: string): Promise<void> {
  const response = await listRuns(get(`http://web/api/runs?${query}`));
  expect(response.status, query).toBe(400);
  if (code !== undefined) expect(await errorCode(response), query).toBe(code);
}

describe('GET /api/runs', () => {
  it(
    'refuses a principal whose role is not one of the four recognised roles by name, rather ' +
      'than silently authorising it as some default (round 2 finding 4: a corrupt membership ' +
      "row is the only input that reaches `decideRunListAccess`'s `role === null` guard)",
    async () => {
      const harness = install({
        authenticate: () =>
          Promise.resolve({ ...PRINCIPAL, role: 'bogus' } as unknown as RunPrincipal),
      });
      await seedRun(harness.store);
      const response = await listRuns(get('http://web/api/runs'));
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('forbidden');
    },
  );

  it('composes status, agent and provider filters as an intersection, not a union', async () => {
    const harness = install();
    const otherAgent = '88888888-8888-4888-8888-888888888888';
    const matches = await seedRun(harness.store);
    const wrongStatus = await seedRun(harness.store);
    const wrongAgent = await seedRun(harness.store, { agentId: otherAgent });
    await harness.store.snapshotModel(matches.id, {
      connectionId: crypto.randomUUID(),
      model: 'gpt-5.1',
      provider: 'openai',
    });
    await harness.store.finish(matches.id, 'failed', 'boom');
    await harness.store.snapshotModel(wrongAgent.id, {
      connectionId: crypto.randomUUID(),
      model: 'gpt-5.1',
      provider: 'openai',
    });
    await harness.store.finish(wrongAgent.id, 'failed', 'boom');
    // wrongStatus keeps provider/agent matching but is never finished (`queued`).
    void wrongStatus;

    const body = await listBody(
      await listRuns(get(`http://web/api/runs?status=failed&agent=${AGENT}&provider=openai`)),
    );
    expect(body.runs.map((run) => run['id'])).toEqual([matches.id]);
  });
});

describe('GET /api/runs', () => {
  it('composes the project filter and the from/to date range as an intersection, not a union (round 2 finding 3)', async () => {
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    let clockMs = base;
    // A controlled clock, one tick (1s) per `create()`, so `from`/`to` can be set to include or
    // exclude a specific run by name rather than racing the real clock.
    const store = new InMemoryRunStore({ now: (): Date => new Date((clockMs += 1000)) });
    const harness = install({}, store);
    const projectId = crypto.randomUUID();
    const otherProjectId = crypto.randomUUID();

    // Ticks, in creation order: tooEarly=+1s, match=+2s, wrongProject=+3s, tooLate=+4s.
    const tooEarly = await seedRun(harness.store, { projectId });
    const match = await seedRun(harness.store, { projectId });
    const wrongProject = await seedRun(harness.store, { projectId: otherProjectId });
    const tooLate = await seedRun(harness.store, { projectId });

    const from = new Date(base + 1_500).toISOString(); // after tooEarly, before match
    const to = new Date(base + 3_500).toISOString(); // after wrongProject, before tooLate

    const body = await listBody(
      await listRuns(get(`http://web/api/runs?project=${projectId}&from=${from}&to=${to}`)),
    );
    const ids = body.runs.map((run) => run['id']);
    // A regression that drops `project` from the query would leak `wrongProject` in; one that
    // drops `from` would leak `tooEarly`; one that drops `to` would leak `tooLate`. Each is a
    // widening this one intersection catches by name.
    expect(ids).toEqual([match.id]);
    expect(ids).not.toContain(tooEarly.id);
    expect(ids).not.toContain(wrongProject.id);
    expect(ids).not.toContain(tooLate.id);

    // Sanity: without the date range, all three same-project runs are visible — the range, not
    // the project filter, is what excluded `tooEarly` and `tooLate` above.
    const withoutRange = await listBody(
      await listRuns(get(`http://web/api/runs?project=${projectId}`)),
    );
    expect(withoutRange.runs.map((run) => run['id'])).toEqual(
      expect.arrayContaining([tooEarly.id, match.id, tooLate.id]),
    );
  });
});

describe('GET /api/runs', () => {
  it(
    'rejects a malformed cursor, an out-of-range limit, an unknown status, and every other ' +
      'malformed filter by name (round 2 finding 2: project, model, to, date-range order, user)',
    async () => {
      install();
      await expectRefused('cursor=not-base64url-json', 'invalid_cursor');
      // A well-formed envelope around a `createdAt` that `new Date()` accepts but no store ever
      // minted (round 3 finding 4): refused by shape here, before any store sees it. The
      // real-PostgreSQL probes live in `store.test.ts`, where the thrown query used to happen.
      for (const createdAt of ['1', '2026-09-12', '0000-01-01T00:00:00.000000Z']) {
        const envelope = JSON.stringify({ createdAt, id: crypto.randomUUID() });
        const cursor = Buffer.from(envelope, 'utf8').toString('base64url');
        await expectRefused(`cursor=${cursor}`, 'invalid_cursor');
      }

      const unnamed = [
        'limit=0',
        'limit=201',
        'limit=abc',
        'status=not-a-status',
        'provider=not-a-provider',
        'agent=not-a-uuid',
        'from=not-a-date',
      ];
      for (const query of unnamed) await expectRefused(query);

      // Each malformed filter is refused by its own code, not silently ignored or forwarded to a
      // query that would error some other way. An empty `model` is a caller mistake, not "no
      // filter"; `to` before `from` is a malformed range, not silently swapped; and an Owner's
      // malformed `user` must not reach the store as a literal string.
      const named: Array<[string, string]> = [
        ['project=not-a-uuid', 'invalid_project'],
        ['model=%20%20', 'invalid_model'],
        ['to=not-a-date', 'invalid_to'],
        ['from=2026-01-02T00:00:00.000Z&to=2026-01-01T00:00:00.000Z', 'invalid_date_range'],
        ['user=not-a-uuid', 'invalid_user'],
      ];
      for (const [query, code] of named) await expectRefused(query, code);
    },
  );
});

describe('GET /api/runs', () => {
  it('paginates by (created_at, id): no duplicate and nothing pre-existing skipped', async () => {
    const harness = install();
    const seeded: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      seeded.push((await seedRun(harness.store)).id);
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    // Bounded (round 3 finding 8): a cursor that stops advancing re-serves page one forever, and
    // `InMemoryRunStore` answers from a resolved promise, so vitest's timeout never fires — the
    // walk has to fail by name itself. Five runs at two a page is three pages.
    for (let page = 1; ; page += 1) {
      if (page > 3) throw new Error('the cursor is not advancing: a fourth page was requested');
      const url =
        cursor === null
          ? 'http://web/api/runs?limit=2'
          : `http://web/api/runs?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const body = await listBody(await listRuns(get(url)));
      // Every page but the last is exactly `limit` long (round 3 finding 6).
      if (body.nextCursor !== null) expect(body.runs).toHaveLength(2);
      collected.push(...body.runs.map((run) => run['id'] as string));
      if (body.nextCursor === null) break;
      cursor = body.nextCursor;
    }
    expect(new Set(collected).size).toBe(collected.length);
    expect(collected.sort()).toEqual([...seeded].sort());
  });
});

describe('GET /api/runs', () => {
  it('renders list items with the exact serialiser GET /api/runs/:id uses, with the exact derived duration', async () => {
    // A controlled clock: `create` at +0 s, `markRunning` at +1 s, `finish` at +24.456 s, so the
    // derived `durationMs` is a number this test names — 23 456 — on the list and on the detail
    // route alike, not merely "some number" (round 4 finding 1).
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const ticks = [0, 1_000, 24_456];
    let tick = 0;
    const store = new InMemoryRunStore({
      now: (): Date => {
        const offset = ticks[tick];
        if (offset === undefined) throw new Error('the controlled clock was read too many times');
        tick += 1;
        return new Date(base + offset);
      },
    });
    const harness = install({}, store);
    const run = await seedRun(harness.store, { projectId: '99999999-9999-4999-8999-999999999999' });
    await harness.store.snapshotModel(run.id, {
      connectionId: crypto.randomUUID(),
      model: 'claude-opus-4-5',
      provider: 'anthropic',
    });
    await harness.store.markRunning(run.id);
    await harness.store.finish(run.id, 'completed', null);

    const listed = await listBody(await listRuns(get('http://web/api/runs')));
    const fromList = listed.runs.find((item) => item['id'] === run.id);
    const detail = (await (await readRun(get(`http://web/api/runs/${run.id}`), run.id)).json()) as {
      run: Record<string, unknown>;
    };
    // The detail is the list item plus its tree (ADR-0104), and nothing else differs.
    const { children, treeCost, ...detailRun } = detail.run;
    expect(fromList).toEqual(detailRun);
    expect({ children, treeCost }).toEqual({
      children: [],
      treeCost: { amount: '0.000000', currency: 'USD' },
    });
    expect(fromList).toMatchObject({
      projectId: '99999999-9999-4999-8999-999999999999',
      initiatingUserId: PRINCIPAL.userId,
      provider: 'anthropic',
      model: 'claude-opus-4-5',
      accountingState: 'pending',
      startedAt: '2026-01-01T00:00:01.000Z',
      endedAt: '2026-01-01T00:00:24.456Z',
      durationMs: 23_456,
    });
    expect((fromList?.['usage'] as { totalTokens: number }).totalTokens).toBe(0);
  });
});

/**
 * Issue #135: "duration and total tokens are deterministic derived values", and #134's
 * `accounting_state` is carried through. `InMemoryRunStore` has no way to set usage counters,
 * so the serialiser is pinned here on a hand-built record whose every counter is non-zero and
 * distinct — `totalTokens` is wrong by a different amount for each counter a regression drops —
 * and again over the repository store, on real PostgreSQL, in `store.test.ts` (round 4
 * finding 1).
 */
describe('GET /api/runs', () => {
  it('renderRun derives durationMs and totalTokens from the persisted fields and maps accountingState through', () => {
    const record: RunRecord = {
      id: newRunId(),
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
      status: 'completed',
      createdAt: new Date('2026-09-12T05:00:00.000Z'),
      startedAt: new Date('2026-09-12T05:00:01.000Z'),
      endedAt: new Date('2026-09-12T05:00:24.456Z'),
      model: 'gpt-5.1',
      provider: 'openai',
      modelConnectionId: null,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
      toolCalls: 5,
      costUsd: '0.123456',
      costCurrency: 'USD',
      priceTableVersion: 'v1',
      error: null,
      accountingState: 'complete',
      accountingError: null,
      projectId: null,
      initiatingUserId: PRINCIPAL.userId,
    };
    const rendered = renderRun(record);
    expect(rendered['durationMs']).toBe(23_456);
    expect(rendered['usage']).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
      totalTokens: 37,
      toolCalls: 5,
    });
    expect(rendered['accountingState']).toBe('complete');
    expect(rendered['cost']).toEqual({
      amount: '0.123456',
      currency: 'USD',
      priceTableVersion: 'v1',
    });
    expect(
      renderRun({
        ...record,
        accountingState: 'failed',
        accountingError:
          'new row for relation "runs" violates check constraint "runs_unpriced_cost_zero"',
        costUsd: '0.000000',
        priceTableVersion: null,
      })['accountingError'],
    ).toBe('Usage accounting could not be completed.');

    // A run that has not ended has no duration — a fact about the run, not a zero.
    expect(renderRun({ ...record, status: 'running', endedAt: null })['durationMs']).toBeNull();
    expect(renderRun({ ...record, accountingState: 'failed' })['accountingState']).toBe('failed');
  });

  it("renderRun masks the run's host directory in its error and the call awaiting approval (UX-02 in #2086)", () => {
    const cwd = `/srv/runner-ws/${WORKSPACE}/${SESSION}`;
    const record: RunRecord = {
      id: newRunId(),
      workspaceId: WORKSPACE,
      agentId: AGENT,
      sessionId: SESSION,
      status: 'awaiting_approval',
      createdAt: new Date('2026-11-05T00:00:00.000Z'),
      startedAt: null,
      endedAt: null,
      error: `ENOENT: no such file or directory, open '${cwd}/outputs/report.md'`,
      pendingApproval: {
        toolName: 'Write',
        canonicalCall: JSON.stringify({ file_path: `${cwd}/outputs/report.md` }),
      },
      output: { text: `${cwd}/kept`, structured: null },
    };
    const rendered = renderRun(record);
    expect(rendered['error']).toBe(
      "ENOENT: no such file or directory, open '<workspace>/outputs/report.md'",
    );
    expect(rendered['pendingApproval']).toEqual({
      toolName: 'Write',
      canonicalCall: JSON.stringify({ file_path: '<workspace>/outputs/report.md' }),
    });
    // The result is the caller's, and is served as the run produced it.
    expect(rendered['output']).toEqual({ text: `${cwd}/kept`, structured: null });
  });
});
