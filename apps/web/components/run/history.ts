/**
 * The Runs history screen's data model — issue #136 (W9-UI-136), against the real, already-landed
 * `GET /api/runs` and `GET /api/runs/:id` (issue #135, `apps/web/server/runs/api.ts`'s
 * `renderRun`). What lives here is what a test can call without a browser or a running server:
 * parsing the JSON both routes answer, holding filters and pagination in a URL, and turning a
 * run's durable fields into the words this screen shows. `history-screen.tsx` and
 * `run-detail-panel.tsx` are layout and the fetches themselves, the split `../agents/model.ts`
 * already established for the agent screens.
 *
 * ## Why this never reads the process-local telemetry projection
 *
 * `docs/adr/W9-PLAN-metrics-is-operational-not-product.md` records that projection as incomplete by
 * construction and reserved for operators. A fallback to it when `GET /api/runs` fails would show
 * fewer runs than exist while looking like a full history — the silent downgrade §9.3 gate 5
 * forbids — so no function here reads it, and none accepts its shape.
 *
 * ## Why `accountingState` is restated here rather than imported
 *
 * `apps/web/server/runs/store.ts`'s own header gives the reason `RUN_STATUS_NAMES` is restated in
 * `@indx-workspace/react/run-model`: this module is reachable from a `'use client'` component, and nothing under
 * `apps/web/server/**` — Node-only modules included — may be imported from one. `history.test.ts`
 * asserts {@link ACCOUNTING_STATE_NAMES} agrees with `store.ts`'s `accountingStates`, the same way
 * `model.test.ts` already does for run statuses.
 *
 * ## Why a durable run's `status` remains a string, while accounting is checked as a closed state
 *
 * `@indx-workspace/react/run-model`'s `badgeForRunStatus` renders an unrecognised status "in its own words, rather than
 * hidden" instead of throwing — a value this screen did not expect is real data from a server that
 * knows more than this build does, not malformed input. {@link describeCost} and the status badge
 * both follow that precedent: the *shape* of a run (an object with the fields below, of the right
 * JS types) is checked positively and rejected by name when it is wrong, but the *vocabulary*
 * inside `status` is total over what this build recognises and falls back to showing the raw word
 * for what it does not. Accounting is different: its state controls whether a number may be shown
 * as actual cost, so an unknown or internally inconsistent state is a malformed response and is
 * refused before rendering.
 *
 * ## Why the key lists are checked against the contract, while the parser stays hand-written
 *
 * {@link RUN_KEYS}, {@link USAGE_KEYS} and {@link COST_KEYS} `satisfies` the
 * `@indx-workspace/contracts/runs` types (a type-only import, erased at build time), and
 * `history.test.ts` asserts they equal the contract schemas' key sets, so a field added to
 * `RunResourceSchema` fails CI instead of every row in the browser (issue #1130). The parser itself
 * stays hand-written for the reasons above: zod's closed enums would refuse a status this build
 * does not know, and its messages would not name the field the way this screen's do.
 */
import type {
  RunCost as ContractRunCost,
  RunResource,
  RunUsage as ContractRunUsage,
} from '@indx-workspace/contracts/runs';
import { badgeForRunStatus, RUN_STATUS_NAMES } from '@indx-workspace/react/run-model';
import { AgentListResponseSchema } from '../../contracts/agents';
import { ProjectListResponseSchema } from '../../contracts/projects';
import { parseWorkspaceList } from '../shell/workspaces-directory';
import {
  describeRequestFailure,
  describeTransportRejection,
  isApiErrorEnvelope,
  type RequestProblem,
} from '../agents/model';

export { describeRequestFailure, describeTransportRejection };
export type { RequestProblem };

// ── The accounting-state vocabulary (issue #134) ────────────────────────────────────────────────

/** Restated from `apps/web/server/runs/store.ts`'s `accountingStates` — see this file's header. */
export const ACCOUNTING_STATE_NAMES = [
  'pending',
  'complete',
  'partial',
  'failed',
  'unavailable',
] as const;

/** Poll cadence for durable snapshots while a run is still queued or running. */
export const RUN_POLL_INTERVAL_MS = 4000;

// ── One run, as this screen reads it ────────────────────────────────────────────────────────────

/** A run's usage, exactly as `renderRun`'s `usage` object shapes it. */
interface RunUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly totalTokens: number;
  readonly toolCalls: number;
}

/** A run's cost, exactly as `renderRun`'s `cost` object shapes it. */
interface RunCost {
  readonly amount: string;
  readonly currency: string;
  readonly priceTableVersion: string | null;
}

/**
 * One run, parsed from either `GET /api/runs`' `runs[]` or `GET /api/runs/:id`'s `run` — the same
 * `renderRun` shapes both (issue #135's "list and detail cannot drift"), so one type and one
 * parser serve both routes.
 */
export interface RunListItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly projectId: string | null;
  readonly initiatingUserId: string | null;
  readonly sessionId: string;
  /** Total over {@link RUN_STATUS_NAMES}, but not narrowed to it — see this file's header. */
  readonly status: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly model: string | null;
  readonly provider: string | null;
  readonly modelConnectionId: string | null;
  /** The engine that executed the run (ADR-0065). `null` for a run recorded before it existed. */
  readonly engine: string | null;
  /** The engine version the runner reported (ADR-0065). `null` when historic or unreported. */
  readonly engineVersion: string | null;
  readonly usage: RunUsage;
  readonly cost: RunCost;
  readonly error: string | null;
  /** Checked against {@link ACCOUNTING_STATE_NAMES} at the response boundary. */
  readonly accountingState: string;
  readonly accountingError: string | null;
}

/** {@link parseRunResource} refuses a value by throwing this, naming what it expected. */
export class MalformedRunError extends TypeError {}

/** Canonical text accepted by PostgreSQL's `uuid` columns (any UUID version). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * `runs.cost_usd` is `numeric(14, 6)`: at most eight integer digits and exactly six fractional
 * digits come back from the durable API. Keeping this as text preserves the accounting value;
 * the finite-number check only proves it is safe to hand to `Intl.NumberFormat` for display.
 */
const USD_AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,7})\.\d{6}$/u;

export const RUN_KEYS = [
  'id',
  'workspaceId',
  'agentId',
  'projectId',
  'initiatingUserId',
  'sessionId',
  'status',
  'createdAt',
  'startedAt',
  'endedAt',
  'durationMs',
  'model',
  'provider',
  'modelConnectionId',
  'engine',
  'engineVersion',
  'usage',
  'cost',
  'error',
  'accountingState',
  'accountingError',
] as const satisfies readonly (keyof RunResource)[];
export const USAGE_KEYS = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'totalTokens',
  'toolCalls',
] as const satisfies readonly (keyof ContractRunUsage)[];
export const COST_KEYS = [
  'amount',
  'currency',
  'priceTableVersion',
] as const satisfies readonly (keyof ContractRunCost)[];
const RUN_LIST_KEYS = ['runs', 'nextCursor'] as const;
const RUN_DETAIL_KEYS = ['run'] as const;

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new MalformedRunError(`${where}: "${key}" must be a string, got ${typeof value}`);
  }
  return value;
}

function requireUuid(record: Record<string, unknown>, key: string, where: string): string {
  const value = requireString(record, key, where);
  if (!UUID_PATTERN.test(value)) {
    throw new MalformedRunError(`${where}: "${key}" must be a UUID`);
  }
  return value;
}

function requireNullableUuid(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | null {
  const value = requireNullableString(record, key, where);
  if (value !== null && !UUID_PATTERN.test(value)) {
    throw new MalformedRunError(`${where}: "${key}" must be a UUID or null`);
  }
  return value;
}

function requireUsdAmount(record: Record<string, unknown>, key: string, where: string): string {
  const amount = requireString(record, key, where);
  const displayValue = Number(amount);
  if (!USD_AMOUNT_PATTERN.test(amount) || !Number.isFinite(displayValue) || displayValue < 0) {
    throw new MalformedRunError(
      `${where}: "${key}" must be a finite non-negative USD decimal with six fractional digits`,
    );
  }
  return amount;
}

function requireNullableString(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new MalformedRunError(`${where}: "${key}" must be a string or null, got ${typeof value}`);
  }
  return value;
}

function requireNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  where: string,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new MalformedRunError(`${where}: "${key}" must be a non-negative safe integer`);
  }
  return value;
}

function requireTimestamp(record: Record<string, unknown>, key: string, where: string): string {
  const value = requireString(record, key, where);
  const parsed = new Date(value);
  // `Date#toISOString()` is the producer used by `renderRun`. Exact round-tripping both rejects
  // impossible dates and proves the input has that producer's UTC/millisecond grammar; a second
  // regular expression would be a redundant conjunct with no independently load-bearing case.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new MalformedRunError(`${where}: "${key}" must be an ISO-8601 UTC timestamp`);
  }
  return value;
}

function requireNullableTimestamp(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | null {
  const value = requireNullableString(record, key, where);
  if (value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new MalformedRunError(`${where}: "${key}" must be an ISO-8601 UTC timestamp or null`);
  }
  return value;
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedRunError(`${where} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireExactObject<const Key extends string>(
  value: unknown,
  keys: readonly Key[],
  where: string,
): Record<Key, unknown> {
  const record = requireObject(value, where);
  const actualKeys = Object.keys(record);
  if (actualKeys.length !== keys.length || !keys.every((key) => Object.hasOwn(record, key))) {
    throw new MalformedRunError(`${where} must contain exactly: ${keys.join(', ')}`);
  }
  return record;
}

/**
 * Parse one run out of either route's JSON. **Never trusts the shape** — a run this screen cannot
 * read correctly is refused by name (ADR-0015) rather than shown with fields silently blank, which
 * is exactly the "0 tokens" / "$0.00" misrepresentation issue #136 exists to avoid.
 */
export function parseRunResource(value: unknown, where = 'run'): RunListItem {
  const record = requireExactObject(value, RUN_KEYS, where);
  const usageRecord = requireExactObject(record['usage'], USAGE_KEYS, `${where}.usage`);
  const costRecord = requireExactObject(record['cost'], COST_KEYS, `${where}.cost`);
  const durationRaw = record['durationMs'];
  if (
    durationRaw !== null &&
    (typeof durationRaw !== 'number' || !Number.isSafeInteger(durationRaw) || durationRaw < 0)
  ) {
    throw new MalformedRunError(
      `${where}: "durationMs" must be a non-negative safe integer or null`,
    );
  }
  const usage = {
    inputTokens: requireNonNegativeInteger(usageRecord, 'inputTokens', `${where}.usage`),
    outputTokens: requireNonNegativeInteger(usageRecord, 'outputTokens', `${where}.usage`),
    cacheReadInputTokens: requireNonNegativeInteger(
      usageRecord,
      'cacheReadInputTokens',
      `${where}.usage`,
    ),
    cacheCreationInputTokens: requireNonNegativeInteger(
      usageRecord,
      'cacheCreationInputTokens',
      `${where}.usage`,
    ),
    totalTokens: requireNonNegativeInteger(usageRecord, 'totalTokens', `${where}.usage`),
    toolCalls: requireNonNegativeInteger(usageRecord, 'toolCalls', `${where}.usage`),
  };
  const derivedTotal =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens;
  if (usage.totalTokens !== derivedTotal) {
    throw new MalformedRunError(
      `${where}.usage: "totalTokens" must equal the four persisted token counters`,
    );
  }
  const amount = requireUsdAmount(costRecord, 'amount', `${where}.cost`);
  const currency = requireString(costRecord, 'currency', `${where}.cost`);
  if (currency !== 'USD') {
    throw new MalformedRunError(`${where}.cost: "currency" must be USD`);
  }
  const priceTableVersion = requireNullableString(costRecord, 'priceTableVersion', `${where}.cost`);
  if (priceTableVersion !== null && priceTableVersion.trim() === '') {
    throw new MalformedRunError(`${where}.cost: "priceTableVersion" must not be empty`);
  }
  const accountingState = requireString(record, 'accountingState', where);
  if (!(ACCOUNTING_STATE_NAMES as readonly string[]).includes(accountingState)) {
    throw new MalformedRunError(`${where}: "accountingState" is not recognised`);
  }
  const accountingError = requireNullableString(record, 'accountingError', where);
  const isPriced = accountingState === 'complete' || accountingState === 'partial';
  if (isPriced !== (priceTableVersion !== null)) {
    throw new MalformedRunError(
      `${where}: priced accounting states and "priceTableVersion" must be present together`,
    );
  }
  if ((accountingState === 'failed') !== (accountingError !== null)) {
    throw new MalformedRunError(
      `${where}: only failed accounting may carry "accountingError", and failed must carry it`,
    );
  }
  if (!isPriced && amount !== '0.000000') {
    throw new MalformedRunError(`${where}: an unpriced accounting state must carry zero cost`);
  }
  return {
    id: requireUuid(record, 'id', where),
    workspaceId: requireUuid(record, 'workspaceId', where),
    agentId: requireUuid(record, 'agentId', where),
    projectId: requireNullableUuid(record, 'projectId', where),
    initiatingUserId: requireNullableUuid(record, 'initiatingUserId', where),
    sessionId: requireUuid(record, 'sessionId', where),
    status: requireString(record, 'status', where),
    createdAt: requireTimestamp(record, 'createdAt', where),
    startedAt: requireNullableTimestamp(record, 'startedAt', where),
    endedAt: requireNullableTimestamp(record, 'endedAt', where),
    durationMs: durationRaw,
    model: requireNullableString(record, 'model', where),
    provider: requireNullableString(record, 'provider', where),
    modelConnectionId: requireNullableUuid(record, 'modelConnectionId', where),
    engine: requireNullableString(record, 'engine', where),
    engineVersion: requireNullableString(record, 'engineVersion', where),
    usage,
    cost: {
      amount,
      currency,
      priceTableVersion,
    },
    error: requireNullableString(record, 'error', where),
    accountingState,
    accountingError,
  };
}

/** The parsed shape of `GET /api/runs`. */
export interface RunListPage {
  readonly runs: readonly RunListItem[];
  readonly nextCursor: string | null;
}

/** Parse `GET /api/runs`'s body. Refused by name when the envelope itself is not what it claims. */
export function parseRunListPage(value: unknown): RunListPage {
  const record = requireExactObject(value, RUN_LIST_KEYS, 'the run list response');
  const rawRuns = record['runs'];
  if (!Array.isArray(rawRuns)) {
    throw new MalformedRunError('the run list response has no "runs" array');
  }
  const nextCursor = record['nextCursor'];
  if (nextCursor !== null && typeof nextCursor !== 'string') {
    throw new MalformedRunError('the run list response\'s "nextCursor" must be a string or null');
  }
  return {
    runs: rawRuns.map((entry, index) => parseRunResource(entry, `runs[${String(index)}]`)),
    nextCursor,
  };
}

/** Parse `GET /api/runs/:id`'s body: `{ run: <RunListItem> }`. */
export function parseRunDetailResponse(value: unknown): RunListItem {
  const record = requireExactObject(value, RUN_DETAIL_KEYS, 'the run detail response');
  return parseRunResource(record['run'], 'run');
}

// ── Filters and pagination, held in the URL ─────────────────────────────────────────────────────

/** Every filter this screen offers, each optional — an absent filter matches every run. */
export interface RunListFilters {
  /** A current-page text search. It is URL state, but not sent to the API (which has no search). */
  readonly query?: string;
  readonly status?: string;
  readonly agentId?: string;
  readonly projectId?: string;
  readonly userId?: string;
}

/** The one query-string vocabulary both this screen and `GET /api/runs` agree on. */
const FILTER_PARAM: Readonly<Record<keyof RunListFilters, string>> = {
  query: 'q',
  status: 'status',
  agentId: 'agent',
  projectId: 'project',
  userId: 'user',
};

/**
 * Read the filters a URL's search params carry. Never throws: an unrecognised `status` is kept as
 * typed (the server is the authority on what it accepts, and rejects it by name if it is wrong —
 * this function only decides what this screen sends, not whether the server will take it).
 */
export function filtersFromSearchParams(params: URLSearchParams): RunListFilters {
  const filters: {
    query?: string;
    status?: string;
    agentId?: string;
    projectId?: string;
    userId?: string;
  } = {};
  const query = params.get(FILTER_PARAM.query);
  if (query !== null && query.trim() !== '') filters.query = query;
  const status = params.get(FILTER_PARAM.status);
  if (status !== null && status !== '') filters.status = status;
  const agentId = params.get(FILTER_PARAM.agentId);
  if (agentId !== null && agentId !== '') filters.agentId = agentId;
  const projectId = params.get(FILTER_PARAM.projectId);
  if (projectId !== null && projectId !== '') filters.projectId = projectId;
  const userId = params.get(FILTER_PARAM.userId);
  if (userId !== null && userId !== '') filters.userId = userId;
  return filters;
}

/** The canonical UUID `?run=<id>` names, or `null` when the URL carries none or malformed text. */
export function runIdFromSearchParams(params: URLSearchParams): string | null {
  const run = params.get('run');
  return run !== null && UUID_PATTERN.test(run) ? run : null;
}

/** A detail endpoint path only for a canonical UUID; invalid text never reaches path construction. */
export function runDetailPath(runId: string): string | null {
  return UUID_PATTERN.test(runId) ? `/api/runs/${runId}` : null;
}

/** The pagination cursor `?cursor=` carries, or `null`. Opaque — never inspected, only forwarded. */
export function cursorFromSearchParams(params: URLSearchParams): string | null {
  const cursor = params.get('cursor');
  return cursor === null || cursor === '' ? null : cursor;
}

/**
 * The exact query string this screen sends to `GET /api/runs` for a set of filters and a cursor.
 * Only the four server-recognised filter names and `cursor` are written. The URL's `q` is a
 * current-page search and is deliberately not forwarded as an unknown server parameter.
 */
export function runsListQuery(filters: RunListFilters, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filters.status !== undefined) params.set(FILTER_PARAM.status, filters.status);
  if (filters.agentId !== undefined) params.set(FILTER_PARAM.agentId, filters.agentId);
  if (filters.projectId !== undefined) params.set(FILTER_PARAM.projectId, filters.projectId);
  if (filters.userId !== undefined) params.set(FILTER_PARAM.userId, filters.userId);
  if (cursor !== null) params.set('cursor', cursor);
  return params.toString();
}

/**
 * The URL search params a link should carry to reach a given screen state, built from the current
 * params so a control that changes one thing (a filter, the selected run) never drops another
 * (issue #136's "filters … held in the URL so a view is linkable").
 */
export function withScreenState(
  current: URLSearchParams,
  patch: { readonly run?: string | null; readonly cursor?: string | null } & Partial<
    Record<keyof RunListFilters, string | null>
  >,
): URLSearchParams {
  const next = new URLSearchParams(current);
  const set = (key: string, value: string | null | undefined): void => {
    if (value === undefined) return;
    if (value === null) next.delete(key);
    else next.set(key, value);
  };
  set('run', patch.run);
  set('cursor', patch.cursor);
  set(FILTER_PARAM.query, patch.query);
  set(FILTER_PARAM.status, patch.status);
  set(FILTER_PARAM.agentId, patch.agentId);
  set(FILTER_PARAM.projectId, patch.projectId);
  set(FILTER_PARAM.userId, patch.userId);
  return next;
}

// ── The `user` filter's availability (issue #136's "shown only when the server accepts it") ────

/**
 * A syntactically valid, never-real user id. Probing `GET /api/runs` with this value as `user=`
 * costs the caller nothing to answer either way: `parseRunListQuery` in `server/runs/api.ts`
 * checks the caller's grant **before** it checks whether the id is real, so a grant of `any`
 * answers `200` with an empty page (nobody has this id), and a narrower grant answers
 * `403 user_filter_forbidden` — the same answer it would give for any other id, including a real
 * one. Neither answer is shown to anyone; the probe is discarded once its status is read.
 */
export const USER_FILTER_PROBE_ID = '00000000-0000-0000-0000-000000000000';

export type UserFilterAvailability = 'available' | 'unavailable';

/**
 * Decide whether to show the `user` filter control, from a real response to the probe above.
 * **Never a client-side role table** (the task card's own words): this reads the server's actual
 * answer, so a workspace whose policy later widens or narrows who may filter by user changes this
 * screen with no code here to update. Anything other than a clean `200` or the one named `403` is
 * treated as `'unavailable'` — fail-closed, per ADR-0015: a control this screen cannot confirm the
 * server will honour is not offered.
 */
export function classifyUserFilterProbe(status: number, body: unknown): UserFilterAvailability {
  if (status === 200) {
    try {
      parseRunListPage(body);
      return 'available';
    } catch {
      return 'unavailable';
    }
  }
  if (status === 403 && isApiErrorEnvelope(body) && body.error.code === 'user_filter_forbidden') {
    return 'unavailable';
  }
  return 'unavailable';
}

// ── Rendering a run's fields as words, never as an invented number ─────────────────────────────

/** `Intl.NumberFormat` reused across calls; a token count is always a plain integer. */
const TOKEN_FORMAT = new Intl.NumberFormat('en-US');

/** A token count, thousands-separated. Tokens are real, persisted counters — `0` is a real count. */
export function formatTokenCount(count: number): string {
  return TOKEN_FORMAT.format(count);
}

/**
 * How a run's cost is shown, driven by {@link AccountingStateName} rather than by the amount
 * alone — the whole reason issue #134 (and this task) exist. Total over the vocabulary this build
 * recognises. {@link parseRunResource} refuses an unrecognised or inconsistent accounting state
 * before it can reach this function (ADR-0015: say less, not more, about an untrusted fact).
 */
export type CostDisplay =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly reason: string | null }
  | {
      readonly kind: 'settled';
      readonly partial: boolean;
      readonly provenance: 'actual';
      readonly amount: string;
      readonly currency: string;
    };

export function describeCost(run: RunListItem): CostDisplay {
  const state = run.accountingState;
  if (state === 'pending') return { kind: 'pending' };
  if (state === 'failed') return { kind: 'failed', reason: run.accountingError };
  if (state === 'complete') {
    return {
      kind: 'settled',
      partial: false,
      provenance: 'actual',
      amount: run.cost.amount,
      currency: run.cost.currency,
    };
  }
  if (state === 'partial') {
    return {
      kind: 'settled',
      partial: true,
      provenance: 'actual',
      amount: run.cost.amount,
      currency: run.cost.currency,
    };
  }
  // `parseRunResource` admits `unavailable`; the fallback keeps direct callers fail-closed.
  return { kind: 'unavailable' };
}

/** A `CostDisplay.settled` amount, formatted as currency when the currency is one `Intl` knows. */
export function formatSettledAmount(amount: string, currency: string): string {
  if (
    currency !== 'USD' ||
    !USD_AMOUNT_PATTERN.test(amount) ||
    !Number.isFinite(Number(amount)) ||
    Number(amount) < 0
  ) {
    throw new MalformedRunError('settled cost must be a finite non-negative USD decimal');
  }
  const value = Number(amount);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
}

/** One shared wording path for both the list and detail surfaces. */
export function formatCostDisplay(run: RunListItem): string {
  const display = describeCost(run);
  if (display.kind === 'pending') return 'Pending';
  if (display.kind === 'unavailable') return 'Unavailable';
  if (display.kind === 'failed') {
    return `Accounting failed${display.reason === null ? '' : ` — ${display.reason}`}`;
  }
  return `${formatSettledAmount(display.amount, display.currency)} · Actual${display.partial ? ' · Partial' : ''}`;
}

/**
 * A run's duration in words. `null` is not "0 s" — it is a fact about the run (it has not started,
 * or has not ended), and {@link RunListItem.status} says which. Anything else is formatted from
 * the millisecond count the server derived from real timestamps (`renderRun`'s `durationMs`).
 */
export function formatDuration(durationMs: number | null, status: string): string {
  if (durationMs === null) {
    if (status === 'queued') return 'Not started';
    if (status === 'running') return 'In progress';
    return 'Unknown duration';
  }
  if (durationMs < 1000) return `${String(durationMs)} ms`;
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours)} h ${String(minutes).padStart(2, '0')} m ${String(seconds).padStart(2, '0')} s`;
  }
  if (minutes > 0) return `${String(minutes)} m ${String(seconds).padStart(2, '0')} s`;
  return `${String(seconds)} s`;
}

/** A timestamp in words, or a named absence — never a blank cell. */
export function formatTimestamp(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Visible locale text plus the exact UTC value used by `<time aria-label title>` in the UI. */
export function timestampAccessibilityLabel(iso: string): string {
  return `${formatTimestamp(iso)} (${iso})`;
}

/** Provider and model together, or a named absence for a run that has not resolved either yet. */
export function formatProviderModel(provider: string | null, model: string | null): string {
  if (provider === null && model === null) return 'Not yet resolved';
  if (provider === null) return model ?? 'Not yet resolved';
  if (model === null) return provider;
  return `${provider} · ${model}`;
}

/**
 * Search the current durable page without pretending the API supports history-wide text search.
 * Resolved catalogue labels are passed separately so a visible name is searchable too.
 */
export function runMatchesSearch(
  run: RunListItem,
  query: string | undefined,
  resolvedLabels: readonly string[],
): boolean {
  const needle = query?.trim().toLocaleLowerCase();
  if (needle === undefined || needle === '') return true;
  const fields = [
    run.id,
    run.status,
    run.provider,
    run.model,
    run.sessionId,
    run.agentId,
    run.projectId,
    run.initiatingUserId,
    ...resolvedLabels,
  ];
  return fields.some((field) => field?.toLocaleLowerCase().includes(needle) === true);
}

/**
 * A live poll reconciles by replacing the old durable snapshot. Keeping this as a pure function
 * makes the no-addition invariant mutation-testable independently of React timing.
 */
export function reconcileDurableRun(_previous: RunListItem | null, next: RunListItem): RunListItem {
  return next;
}

/** Only non-terminal durable states schedule another poll. Unknown states fail closed as terminal. */
export function shouldPollDurableRun(run: Pick<RunListItem, 'status'>): boolean {
  return run.status === 'queued' || run.status === 'running';
}

export { badgeForRunStatus, RUN_STATUS_NAMES };

// ── Resolving an id against a workspace catalogue (agent, project, user, workspace names) ──────

/** One id→label lookup, built once from a `GET` list this screen already has read access to. */
export interface Catalog {
  readonly byId: ReadonlyMap<string, string>;
}

/** A catalogue this screen has not finished loading, could not load, or has loaded. */
export type CatalogState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly catalog: Catalog };

export type CatalogKind = 'agents' | 'projects' | 'users' | 'workspaces';

/**
 * Where this screen reads the project catalogue from — **with `?archived=all`** (issue #184).
 *
 * `GET /api/projects` answers only active projects when the parameter is absent
 * (`server/projects/http.ts`), so without it every run filed under a project would lose its name
 * the moment that project was archived and render as `'deleted'` instead. Named here, rather than
 * inlined at the call site, so the filter is a value a test can assert: reverting it to the bare
 * path fails `history.test.ts`'s "the project catalogue asks for archived projects too".
 */
export const PROJECT_CATALOG_URL = '/api/projects?archived=all';

const USER_CATALOG_KEYS = ['users'] as const;
const USER_ROW_KEYS = ['id', 'email', 'name', 'createdAt'] as const;

/**
 * Read the four catalogue responses used by this screen. Each branch first closes the complete
 * owned envelope and row contract, then projects only `id` and `name`. Agent/project schemas are
 * shared with their producers; the workspace parser is shared with the shell. Only `/api/users`
 * lacks a browser contract, so its four-field response is enumerated locally.
 */
export function parseCatalog(body: unknown, kind: CatalogKind): Catalog {
  let list: readonly { readonly id: string; readonly name: string }[];
  if (kind === 'agents') {
    const parsed = AgentListResponseSchema.safeParse(body);
    if (!parsed.success) throw new MalformedRunError('the agents response is malformed');
    list = parsed.data.agents.map(({ id, name }) => ({ id, name }));
  } else if (kind === 'projects') {
    const parsed = ProjectListResponseSchema.safeParse(body);
    if (!parsed.success) throw new MalformedRunError('the projects response is malformed');
    list = parsed.data.projects.map(({ id, name }) => ({ id, name }));
  } else if (kind === 'workspaces') {
    const parsed = parseWorkspaceList(body);
    if (parsed === null) throw new MalformedRunError('the workspaces response is malformed');
    list = parsed.map(({ id, name }) => ({ id, name }));
  } else {
    const record = requireExactObject(body, USER_CATALOG_KEYS, 'the users response');
    if (!Array.isArray(record.users)) {
      throw new MalformedRunError('the users response has no "users" array');
    }
    list = record.users.map((entry, index) => {
      const row = requireExactObject(entry, USER_ROW_KEYS, `users[${String(index)}]`);
      const id = requireUuid(row, 'id', `users[${String(index)}]`);
      const name = requireString(row, 'name', `users[${String(index)}]`);
      requireString(row, 'email', `users[${String(index)}]`);
      requireTimestamp(row, 'createdAt', `users[${String(index)}]`);
      return { id, name };
    });
  }
  const byId = new Map<string, string>();
  list.forEach((entry, index) => {
    if (!UUID_PATTERN.test(entry.id)) {
      throw new MalformedRunError(`${kind}[${String(index)}]: "id" must be a UUID`);
    }
    byId.set(entry.id, entry.name);
  });
  return { byId };
}

/**
 * How an id this screen wants a label for resolves against one loaded catalogue.
 *
 * `'unknown'` and `'deleted'` are different facts and this function keeps them apart: `'unknown'`
 * means the catalogue itself could not be read (a permission narrowing, or a transport failure),
 * so nothing here may claim the id is gone; `'deleted'` means the catalogue **was** read and this
 * id was not in it. That is positive evidence about the catalogue, but not always about the
 * database: project visibility narrows by role, and today's foreign keys erase/cascade deleted
 * project/agent attribution before a durable run is rendered. The task ADR declares both limits.
 *
 * An *archived* project is no longer one of those causes: `history-screen.tsx` loads the project
 * catalogue with `?archived=all` (issue #184), so retiring a project does not turn its finished
 * runs' attribution into `'deleted'`.
 */
export type ResourceReference =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown'; readonly id: string }
  | { readonly kind: 'deleted'; readonly id: string }
  | { readonly kind: 'resolved'; readonly id: string; readonly label: string };

export function resolveResourceReference(
  id: string | null,
  catalog: CatalogState,
): ResourceReference {
  if (id === null) return { kind: 'absent' };
  if (catalog.kind !== 'ready') return { kind: 'unknown', id };
  const label = catalog.catalog.byId.get(id);
  return label === undefined ? { kind: 'deleted', id } : { kind: 'resolved', id, label };
}
