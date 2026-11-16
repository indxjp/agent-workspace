/**
 * `dashboardRoutes`: J5's "see what agents are doing" (F-5, issue #1522), one route file:
 *
 * ```ts
 * // app/api/dashboard/route.ts
 * export const { GET } = dashboardRoutes();
 * ```
 *
 * `GET /api/dashboard` answers four lists read from Agent Workspace's run list as the signed-in
 * person, with their own token: what is running now (`queued` and `running`), what waits for a
 * decision (`awaiting_approval`), what failed in the last 24 hours, and what today's runs cost by
 * currency. The platform scopes the run list to what the person may see (Owner and Admin every
 * run, Builder and Viewer their own), so a person never sees a run they could not open in the
 * console, and the dashboard keeps nothing of its own: no table, no platform route, no aggregate.
 *
 * Child runs of an agent team (ADR-0104) are runs the person can open, so they are listed with the
 * id of their lead run. Spend is summed exactly on decimal strings ({@link addDecimal}), never as
 * floats; a run whose accounting has not settled is counted as `unsettled`.
 *
 * The page asks every second (a declared shortcut, below). Each person's answer is kept for
 * {@link DASHBOARD_CACHE_MS}, so several tabs cost one platform round a second, and the spend walk
 * is kept for {@link DASHBOARD_SPEND_REFRESH_MS}. Every failure is the one problem envelope (ADR-0075); a
 * refusal of Agent Workspace's is passed on by its code and status.
 */
import {
  RUN_LIST_MAX_LIMIT,
  type RunListQuery,
  type RunListResponse,
  type RunResource,
} from '@indx-workspace/contracts/runs';
import {
  AgentWorkspaceError,
  ApiProblemError,
  createClient,
  type ClientAuth,
} from '@indx-workspace/sdk';

import type {
  DashboardSnapshot,
  DashboardSpend,
  DashboardTruncated,
  RunSummary,
} from '../dashboard-wire.js';
import { addDecimal, isDecimal } from './decimal.js';
import { currentPerson, personAuthOf } from './person.js';
import { NO_STORE } from './problem.js';
import { refusalOf, RequestRefusal } from './routes.js';
import { appRuntime } from './runtime.js';

/** How long one person's lists are answered from memory. */
export const DASHBOARD_CACHE_MS = 900;
/** How long one person's spend walk is answered from memory. */
export const DASHBOARD_SPEND_REFRESH_MS = 10_000;
/** The most pages of today's runs the spend walk reads before it says it is truncated. */
export const DASHBOARD_SPEND_MAX_PAGES = 10;
/** How far back the failed list reaches. */
const DASHBOARD_FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
/** The most people whose answers are kept at once; the oldest is forgotten first. */
const CACHE_MAX_PEOPLE = 1000;
/** A code Agent Workspace answered with, safe to pass on: snake_case, bounded. */
const PROBLEM_CODE = /^[a-z][a-z0-9_]{0,63}$/u;

const MESSAGES = {
  unauthenticated: 'Sign in to Agent Workspace to use this app.',
  refused: 'Agent Workspace refused the request.',
  upstream: 'Agent Workspace did not answer as expected. Try again later.',
} as const;

/** What the dashboard reads of Agent Workspace: the run list, as the person. */
export interface DashboardRunsClient {
  readonly runs: {
    list(query?: RunListQuery): Promise<RunListResponse>;
  };
}

/** What {@link dashboardRoutes} may be given; each has a default. */
export interface DashboardRoutesOptions {
  /** The IANA time zone "today" starts in for the spend list; `UTC` when not given. */
  readonly timeZone?: string;
  /** The clock; the current time by default. */
  readonly now?: () => Date;
}

/** The handler of `app/api/dashboard/route.ts`. */
export interface DashboardRoutes {
  readonly GET: (request: Request) => Promise<Response>;
}

/** The three run lists of a snapshot, and which of them stopped at a page. */
interface DashboardLists {
  readonly running: readonly RunSummary[];
  readonly waiting: readonly RunSummary[];
  readonly failed: readonly RunSummary[];
  readonly truncated: Omit<DashboardTruncated, 'spend'>;
}

/** Today's spend, and whether the walk stopped at {@link DASHBOARD_SPEND_MAX_PAGES}. */
interface DashboardSpendWalk {
  readonly spendToday: readonly DashboardSpend[];
  readonly truncated: boolean;
}

function zoneFormat(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** How far ahead of UTC the wall clock of `format`'s zone is at `at`, in milliseconds. */
function zoneOffsetMs(format: Intl.DateTimeFormat, at: number): number {
  const parts = new Map(format.formatToParts(at).map((part) => [part.type, part.value]));
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.get(type));
  const wall = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
  return wall - Math.floor(at / 1000) * 1000;
}

/**
 * The instant today began in `timeZone` at `now`: its local midnight, as UTC. The offset is read
 * again at the guess, so a day that starts after a daylight-saving change starts at its own offset.
 *
 * @throws {RangeError} when `timeZone` is not one `Intl` knows.
 */
export function startOfDay(now: Date, timeZone = 'UTC'): Date {
  const format = zoneFormat(timeZone);
  const local = now.getTime() + zoneOffsetMs(format, now.getTime());
  const midnight = Math.floor(local / DAY_MS) * DAY_MS;
  const guess = midnight - zoneOffsetMs(format, now.getTime());
  return new Date(midnight - zoneOffsetMs(format, guess));
}

/** A run as the dashboard shows it: never its prompt, output or usage. */
function summaryOf(run: RunResource): RunSummary {
  return {
    id: run.id,
    agentId: run.agentId,
    status: run.status,
    createdAt: run.createdAt,
    durationMs: run.durationMs,
    error: run.error,
    pendingApproval: run.pendingApproval,
    cost: { amount: run.cost.amount, currency: run.cost.currency },
    parentRunId: run.parentRunId,
  };
}

/** Newest first, then by id, so two runs created together keep one order. */
function newestFirst(runs: readonly RunResource[]): RunSummary[] {
  return [...runs]
    .sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )
    .map(summaryOf);
}

/** The run lists, read in parallel, one page of {@link RUN_LIST_MAX_LIMIT} each. */
async function loadLists(aw: DashboardRunsClient, now: Date): Promise<DashboardLists> {
  const page = (query: RunListQuery): Promise<RunListResponse> =>
    aw.runs.list({ ...query, limit: RUN_LIST_MAX_LIMIT });
  const since = now.getTime() - DASHBOARD_FAILED_WINDOW_MS;
  const [queued, running, waiting, failed] = await Promise.all([
    page({ status: 'queued' }),
    page({ status: 'running' }),
    page({ status: 'awaiting_approval' }),
    page({ status: 'failed', from: new Date(since).toISOString() }),
  ]);
  return {
    running: newestFirst([...running.runs, ...queued.runs]),
    waiting: newestFirst(waiting.runs),
    // The platform's `from` already bounds the page; the window is checked here too.
    failed: newestFirst(failed.runs.filter((run) => Date.parse(run.createdAt) >= since)),
    truncated: {
      running: running.nextCursor !== null || queued.nextCursor !== null,
      waiting: waiting.nextCursor !== null,
      failed: failed.nextCursor !== null,
    },
  };
}

interface SpendTotal {
  amount: string;
  runs: number;
  unsettled: number;
}

function addRun(totals: Map<string, SpendTotal>, run: RunResource): void {
  const total = totals.get(run.cost.currency) ?? { amount: '0', runs: 0, unsettled: 0 };
  const known = isDecimal(run.cost.amount);
  totals.set(run.cost.currency, {
    amount: known ? addDecimal(total.amount, run.cost.amount) : total.amount,
    runs: total.runs + 1,
    unsettled: total.unsettled + (run.accountingState === 'complete' && known ? 0 : 1),
  });
}

/** Today's runs, page by page up to {@link DASHBOARD_SPEND_MAX_PAGES}, summed by currency. */
async function loadSpend(
  aw: DashboardRunsClient,
  now: Date,
  timeZone: string,
): Promise<DashboardSpendWalk> {
  const from = startOfDay(now, timeZone).toISOString();
  const totals = new Map<string, SpendTotal>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: RunListResponse = await aw.runs.list({
      from,
      limit: RUN_LIST_MAX_LIMIT,
      ...(cursor === null ? {} : { cursor }),
    });
    for (const run of page.runs) addRun(totals, run);
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor !== null && pages < DASHBOARD_SPEND_MAX_PAGES);
  return {
    spendToday: [...totals]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([currency, total]) => ({ currency, ...total })),
    truncated: cursor !== null,
  };
}

/**
 * J5's four lists at `now`, read from Agent Workspace by `aw`, a client holding the signed-in
 * person's own token: the platform decides which runs they may see.
 *
 * @throws {AgentWorkspaceError} whatever the run list throws.
 */
export async function loadDashboard(
  aw: DashboardRunsClient,
  now: Date,
  timeZone = 'UTC',
): Promise<DashboardSnapshot> {
  const [lists, spend] = await Promise.all([loadLists(aw, now), loadSpend(aw, now, timeZone)]);
  return snapshotOf(lists, spend, now);
}

function snapshotOf(
  lists: DashboardLists,
  spend: DashboardSpendWalk,
  asOf: Date,
): DashboardSnapshot {
  return {
    running: lists.running,
    waiting: lists.waiting,
    failed: lists.failed,
    spendToday: spend.spendToday,
    asOf: asOf.toISOString(),
    truncated: { ...lists.truncated, spend: spend.truncated },
  };
}

/** A failure of Agent Workspace's: a refusal (`4xx`) by its code and status, else `502`. */
function failureOf(error: unknown): Response {
  if (error instanceof ApiProblemError && error.status >= 400 && error.status < 500) {
    const code = PROBLEM_CODE.test(error.code) ? error.code : 'upstream_refused';
    return refusalOf(new RequestRefusal(code, error.status, MESSAGES.refused));
  }
  if (error instanceof AgentWorkspaceError) {
    return refusalOf(new RequestRefusal('upstream_failure', 502, MESSAGES.upstream));
  }
  return refusalOf(error);
}

/** One answer being read or held: when its read began, and the read. */
interface Held<T> {
  readonly at: number;
  readonly value: Promise<T>;
}

/** What is held for one person: their lists and their spend, each with its own age. */
interface PersonEntry {
  lists?: Held<{ readonly lists: DashboardLists; readonly asOf: Date }>;
  spend?: Held<DashboardSpendWalk>;
}

function cacheKeyOf(auth: ClientAuth): string {
  return 'token' in auth ? `${auth.kind}:${auth.token}` : auth.kind;
}

/** Holds `read()` from `at`; a failed read is let go by `forget`, so the next request asks again. */
function heldOf<T>(at: number, read: () => Promise<T>, forget: (held: Held<T>) => void): Held<T> {
  const held: Held<T> = { at, value: read() };
  held.value.catch(() => {
    forget(held);
  });
  return held;
}

/** Forgets every entry no read of the last {@link DASHBOARD_SPEND_REFRESH_MS} touched. */
function prune(cache: Map<string, PersonEntry>, at: number): void {
  for (const [key, entry] of cache) {
    const touched = Math.max(entry.lists?.at ?? 0, entry.spend?.at ?? 0);
    if (at - touched >= DASHBOARD_SPEND_REFRESH_MS) cache.delete(key);
  }
  while (cache.size >= CACHE_MAX_PEOPLE) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}

/**
 * The handler of `app/api/dashboard/route.ts`: J5's four lists as the signed-in person.
 *
 * @throws {RangeError} when `options.timeZone` is not one `Intl` knows, when the route is built.
 */
export function dashboardRoutes(options: DashboardRoutesOptions = {}): DashboardRoutes {
  // shortcut: polling, not a workspace event stream; replace with N-3 webhooks or a workspace SSE when one exists
  const timeZone = options.timeZone ?? 'UTC';
  zoneFormat(timeZone);
  const now = options.now ?? (() => new Date());
  const cache = new Map<string, PersonEntry>();

  async function personClient(request: Request, auth: ClientAuth): Promise<DashboardRunsClient> {
    const runtime = appRuntime();
    if ((await currentPerson(request)) === null) {
      throw new RequestRefusal('unauthenticated', 401, MESSAGES.unauthenticated);
    }
    return createClient({
      baseUrl: runtime.awUrl,
      auth,
      ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
    });
  }

  async function serve(request: Request): Promise<DashboardSnapshot> {
    const auth = personAuthOf(request);
    if (auth === undefined) {
      throw new RequestRefusal('unauthenticated', 401, MESSAGES.unauthenticated);
    }
    const asOf = now();
    const at = asOf.getTime();
    const key = cacheKeyOf(auth);
    const found = cache.get(key);
    if (found === undefined) prune(cache, at);
    const entry: PersonEntry = found ?? {};
    cache.set(key, entry);
    // One `GET /api/me` per request at most, and none when both answers are held.
    let pending: Promise<DashboardRunsClient> | undefined;
    const clientOf = (): Promise<DashboardRunsClient> => (pending ??= personClient(request, auth));
    if (entry.lists === undefined || at - entry.lists.at >= DASHBOARD_CACHE_MS) {
      entry.lists = heldOf(
        at,
        async () => ({ lists: await loadLists(await clientOf(), asOf), asOf }),
        (held) => {
          if (entry.lists === held) delete entry.lists;
        },
      );
    }
    if (entry.spend === undefined || at - entry.spend.at >= DASHBOARD_SPEND_REFRESH_MS) {
      entry.spend = heldOf(
        at,
        async () => loadSpend(await clientOf(), asOf, timeZone),
        (held) => {
          if (entry.spend === held) delete entry.spend;
        },
      );
    }
    const [lists, spend] = await Promise.all([entry.lists.value, entry.spend.value]);
    return snapshotOf(lists.lists, spend, lists.asOf);
  }

  return {
    async GET(request) {
      try {
        const snapshot = await serve(request);
        return Response.json(snapshot, { status: 200, headers: { 'cache-control': NO_STORE } });
      } catch (error) {
        return failureOf(error);
      }
    },
  };
}
