import { ApiProblemSchema } from '@indx-workspace/contracts';
import type { RunResource, RunStatus } from '@indx-workspace/contracts/runs';
import { createClient } from '@indx-workspace/sdk';
import {
  fetchDouble,
  fixtures,
  jsonResponse,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { DashboardSnapshotSchema } from '../dashboard-wire.js';
import { FAKE_WORKSPACE_ID } from '../testing/fake-person.js';
import { resetAppRuntimeForTests, setAppRuntimeForTests } from '../testing/runtime.js';
import {
  DASHBOARD_SPEND_MAX_PAGES,
  dashboardRoutes,
  loadDashboard,
  startOfDay,
} from './dashboard.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const TOKEN = 'awu_live_dashboardperson';

let sequence = 0;

/** The run list filters a request carries, each one at most once. */
interface RunListFilters {
  readonly status?: string;
  readonly from?: string;
}

function queryOf(request: RecordedRequest): RunListFilters {
  const query: RunListFilters = Object.fromEntries(request.url.searchParams);
  return query;
}

/** The lower bound on `createdAt` a run list request asked for. */
function lowerBoundOf(request: RecordedRequest | undefined): string | undefined {
  return request === undefined ? undefined : queryOf(request).from;
}

/** A run in `status`, created `hoursAgo` before {@link NOW}. */
function runOf(
  status: RunStatus,
  hoursAgo: number,
  overrides: Partial<RunResource> = {},
): RunResource {
  sequence += 1;
  return fixtures.run({
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    workspaceId: FAKE_WORKSPACE_ID,
    status,
    createdAt: new Date(NOW.getTime() - hoursAgo * HOUR_MS).toISOString(),
    ...overrides,
  });
}

/**
 * A run list as Agent Workspace serves it: filtered by `status` and `from`, newest first, in pages
 * of `pageSize` with an opaque cursor that is the offset.
 */
function platformOf(runs: readonly RunResource[], pageSize = 200) {
  return (request: RecordedRequest): Response => {
    if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
      return jsonResponse(401, { error: { code: 'unauthenticated', message: 'Sign in.' } });
    }
    if (request.url.pathname === '/api/me') {
      return jsonResponse(200, {
        principalId: '33333333-3333-4333-8333-333333333333',
        kind: 'membership',
        role: 'builder',
        workspaceId: FAKE_WORKSPACE_ID,
        userId: '44444444-4444-4444-8444-444444444444',
        label: 'Someone',
        features: [],
      });
    }
    const query = request.url.searchParams;
    const { status, from } = queryOf(request);
    const matching = runs
      .filter((run) => status === undefined || run.status === status)
      .filter((run) => from === undefined || Date.parse(run.createdAt) >= Date.parse(from))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    const offset = Number(query.get('cursor') ?? '0');
    const next = offset + pageSize;
    return jsonResponse(200, {
      runs: matching.slice(offset, next),
      nextCursor: next < matching.length ? String(next) : null,
    });
  };
}

function clientOf(double: ReturnType<typeof fetchDouble>) {
  return createClient({
    baseUrl: 'https://aw.test',
    auth: { kind: 'user-token', token: TOKEN },
    fetch: double.fetch,
  });
}

function request(token: string | null = TOKEN): Request {
  return new Request('https://app.test/api/dashboard', {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

afterEach(() => {
  resetAppRuntimeForTests();
});

describe('loadDashboard', () => {
  it('splits the runs by status, running being queued and running, newest first', async () => {
    const queued = runOf('queued', 0.1);
    const running = runOf('running', 0.5);
    const child = runOf('running', 0.2, { parentRunId: running.id });
    const waiting = runOf('awaiting_approval', 2);
    const done = runOf('completed', 1);
    const double = fetchDouble(platformOf([queued, running, child, waiting, done]));

    const snapshot = await loadDashboard(clientOf(double), NOW);

    expect(snapshot.running.map((run) => run.id)).toEqual([queued.id, child.id, running.id]);
    expect(snapshot.running[1]?.parentRunId).toBe(running.id);
    expect(snapshot.waiting.map((run) => run.id)).toEqual([waiting.id]);
    expect(snapshot.waiting[0]?.pendingApproval?.toolName).toBe('send_email');
    expect(snapshot.failed).toEqual([]);
    expect(snapshot.asOf).toBe(NOW.toISOString());
    expect(DashboardSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    const lists = double.calls.filter((call) => call.url.searchParams.has('status'));
    expect(lists.map((call) => call.url.searchParams.get('limit'))).toEqual([
      '200',
      '200',
      '200',
      '200',
    ]);
  });

  it('never carries a prompt, an output or the usage of a run', async () => {
    const run = runOf('completed', 1, {
      output: { text: 'secret answer', structured: null },
      cost: { amount: '0.5', currency: 'USD', priceTableVersion: 'v1' },
    });
    const snapshot = await loadDashboard(
      clientOf(fetchDouble(platformOf([runOf('running', 0), run]))),
      NOW,
    );
    expect(Object.keys(snapshot.running[0] ?? {}).sort()).toEqual([
      'agentId',
      'cost',
      'createdAt',
      'durationMs',
      'error',
      'id',
      'parentRunId',
      'pendingApproval',
      'status',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('secret answer');
  });

  it('lists a failure of exactly 24 hours ago and leaves out one of 25', async () => {
    const edge = runOf('failed', 24);
    const recent = runOf('failed', 3);
    const old = runOf('failed', 25);
    const double = fetchDouble(platformOf([edge, recent, old]));

    const snapshot = await loadDashboard(clientOf(double), NOW);

    expect(snapshot.failed.map((run) => run.id)).toEqual([recent.id, edge.id]);
    const failedQuery = double.calls.find(
      (call) => call.url.searchParams.get('status') === 'failed',
    );
    expect(lowerBoundOf(failedQuery)).toBe('2026-10-31T12:00:00.000Z');
  });

  it('leaves out a 25 h old failure even when the platform answers it', async () => {
    const old = runOf('failed', 25);
    const ignoresFrom = fetchDouble(() => jsonResponse(200, { runs: [old], nextCursor: null }));
    const snapshot = await loadDashboard(clientOf(ignoresFrom), NOW);
    expect(snapshot.failed).toEqual([]);
  });

  it('sums today’s spend exactly by currency and counts the unsettled runs', async () => {
    const usd = (amount: string, accountingState: RunResource['accountingState']) =>
      runOf('completed', 1, {
        cost: { amount, currency: 'USD', priceTableVersion: 'v1' },
        accountingState,
      });
    const yesterday = runOf('completed', 13, {
      cost: { amount: '5.0', currency: 'USD', priceTableVersion: 'v1' },
    });
    const double = fetchDouble(
      platformOf([
        usd('0.1', 'complete'),
        usd('0.2', 'complete'),
        usd('0.000000', 'pending'),
        runOf('running', 0, {
          cost: { amount: '7', currency: 'JPY', priceTableVersion: null },
          accountingState: 'partial',
        }),
        yesterday,
      ]),
    );

    const snapshot = await loadDashboard(clientOf(double), NOW);

    expect(snapshot.spendToday).toEqual([
      { currency: 'JPY', amount: '7', runs: 1, unsettled: 1 },
      { currency: 'USD', amount: '0.300000', runs: 3, unsettled: 1 },
    ]);
    const walk = double.calls.find((call) => !call.url.searchParams.has('status'));
    expect(lowerBoundOf(walk)).toBe('2026-11-01T00:00:00.000Z');
  });

  it('adds 0.1 and 0.2 to exactly 0.3', async () => {
    const at = (amount: string) =>
      runOf('completed', 1, { cost: { amount, currency: 'EUR', priceTableVersion: 'v1' } });
    const snapshot = await loadDashboard(
      clientOf(fetchDouble(platformOf([at('0.1'), at('0.2')]))),
      NOW,
    );
    expect(snapshot.spendToday).toEqual([
      { currency: 'EUR', amount: '0.3', runs: 2, unsettled: 0 },
    ]);
  });

  it('starts today in the time zone it is given', async () => {
    const double = fetchDouble(platformOf([]));
    await loadDashboard(clientOf(double), NOW, 'Asia/Tokyo');
    const walk = double.calls.find((call) => !call.url.searchParams.has('status'));
    expect(lowerBoundOf(walk)).toBe('2026-10-31T15:00:00.000Z');
  });

  it('stops the spend walk at its page limit and says it is truncated', async () => {
    const many = Array.from({ length: DASHBOARD_SPEND_MAX_PAGES + 2 }, () =>
      runOf('completed', 1, {
        cost: { amount: '1', currency: 'USD', priceTableVersion: 'v1' },
      }),
    );
    const double = fetchDouble(platformOf(many, 1));

    const snapshot = await loadDashboard(clientOf(double), NOW);

    const walk = double.calls.filter((call) => !call.url.searchParams.has('status'));
    expect(walk).toHaveLength(DASHBOARD_SPEND_MAX_PAGES);
    expect(snapshot.truncated.spend).toBe(true);
    expect(snapshot.spendToday).toEqual([
      { currency: 'USD', amount: String(DASHBOARD_SPEND_MAX_PAGES), runs: 10, unsettled: 0 },
    ]);
    expect(snapshot.truncated.failed).toBe(false);
  });

  it('says a list is truncated when the platform has another page of it', async () => {
    const running = [runOf('running', 0), runOf('running', 0.1)];
    const snapshot = await loadDashboard(clientOf(fetchDouble(platformOf(running, 1))), NOW);
    expect(snapshot.truncated).toEqual({
      running: true,
      waiting: false,
      failed: false,
      spend: false,
    });
  });
});

describe('startOfDay', () => {
  it('is local midnight as UTC, across a daylight-saving change', () => {
    expect(startOfDay(NOW).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(startOfDay(NOW, 'Asia/Tokyo').toISOString()).toBe('2026-10-31T15:00:00.000Z');
    // New York leaves daylight time at 06:00Z on 2026-11-01: the day began at -04:00.
    expect(startOfDay(NOW, 'America/New_York').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(startOfDay(new Date('2026-11-02T03:00:00.000Z'), 'America/New_York').toISOString()).toBe(
      '2026-11-01T04:00:00.000Z',
    );
    expect(() => startOfDay(NOW, 'Not/AZone')).toThrow(RangeError);
  });
});

describe('dashboardRoutes', () => {
  it('answers the snapshot as the person, no-store', async () => {
    const double = fetchDouble(platformOf([runOf('running', 0)]));
    setAppRuntimeForTests({ fetch: double.fetch });
    const response = await dashboardRoutes({ now: () => NOW }).GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const snapshot = DashboardSnapshotSchema.parse(await response.json());
    expect(snapshot.running).toHaveLength(1);
    expect(
      double.calls.every((call) => call.headers.get('authorization') === `Bearer ${TOKEN}`),
    ).toBe(true);
  });

  it('answers 401 without a person’s token, and passes a platform 401 on', async () => {
    const double = fetchDouble(platformOf([]));
    setAppRuntimeForTests({ fetch: double.fetch });
    const routes = dashboardRoutes({ now: () => NOW });

    const none = await routes.GET(request(null));
    expect(none.status).toBe(401);
    expect(ApiProblemSchema.parse(await none.json()).error.code).toBe('unauthenticated');

    const refusedRuns = fetchDouble((call) =>
      call.url.pathname === '/api/me'
        ? platformOf([])(call)
        : jsonResponse(401, { error: { code: 'token_revoked', message: 'Revoked.' } }),
    );
    setAppRuntimeForTests({ fetch: refusedRuns.fetch });
    const passed = await routes.GET(request());
    expect(passed.status).toBe(401);
    const body = ApiProblemSchema.parse(await passed.json());
    expect(body.error.code).toBe('token_revoked');
    expect(body.error.message).not.toContain('Revoked.');

    const stranger = await routes.GET(request('awu_live_somebodyelse'));
    expect(stranger.status).toBe(401);
  });

  it('answers 502 when Agent Workspace fails, never its words', async () => {
    const failing = fetchDouble((call) =>
      call.url.pathname === '/api/me'
        ? platformOf([])(call)
        : jsonResponse(503, { error: { code: 'database_unavailable', message: 'pg down' } }),
    );
    setAppRuntimeForTests({ fetch: failing.fetch });
    const response = await dashboardRoutes({ now: () => NOW }).GET(request());
    expect(response.status).toBe(502);
    const body = ApiProblemSchema.parse(await response.json());
    expect(body.error.code).toBe('upstream_failure');
    expect(JSON.stringify(body)).not.toContain('pg down');
  });

  it('answers twice within 900 ms from one platform round, and asks again after', async () => {
    const double = fetchDouble(platformOf([runOf('running', 0)]));
    setAppRuntimeForTests({ fetch: double.fetch });
    let clock = NOW.getTime();
    const routes = dashboardRoutes({ now: () => new Date(clock) });

    const [first, second] = await Promise.all([routes.GET(request()), routes.GET(request())]);
    clock += 899;
    const third = await routes.GET(request());
    expect([first.status, second.status, third.status]).toEqual([200, 200, 200]);
    // One round: who the person is, the four lists and one page of today's runs.
    expect(double.calls).toHaveLength(6);

    clock += 1;
    await routes.GET(request());
    // The lists are read again; the spend walk is held for 10 s.
    expect(double.calls).toHaveLength(11);
    const walked = (call: RecordedRequest) =>
      call.url.pathname === '/api/runs' && !call.url.searchParams.has('status');
    expect(double.calls.slice(6).some(walked)).toBe(false);

    clock += 10_000;
    await routes.GET(request());
    expect(double.calls.slice(11).filter((call) => call.url.pathname === '/api/runs')).toHaveLength(
      5,
    );
  });

  it('asks again at once after a failed round', async () => {
    let fail = true;
    const double = fetchDouble((call) =>
      fail && call.url.pathname === '/api/runs'
        ? jsonResponse(503, { error: { code: 'database_unavailable', message: 'down' } })
        : platformOf([])(call),
    );
    setAppRuntimeForTests({ fetch: double.fetch });
    const routes = dashboardRoutes({ now: () => NOW });
    expect((await routes.GET(request())).status).toBe(502);
    fail = false;
    expect((await routes.GET(request())).status).toBe(200);
  });

  it('refuses a time zone Intl does not know when it is built', () => {
    expect(() => dashboardRoutes({ timeZone: 'Mars/Olympus' })).toThrow(RangeError);
  });
});
