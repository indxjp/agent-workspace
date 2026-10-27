import { MODEL_PROVIDERS, type ModelProvider } from '@indx-workspace/contracts/runs';

import { digitGroup, instantOfUtcFields, isKeysetTimestamp } from '../pagination/keyset-timestamp';
import { ownerPrincipalIdOf } from '../rbac/owner-principal';
import type { Grant } from '../rbac/permissions';
import type { RunPrincipal } from './environment';
import { isUuid } from './http';
import { MAX_RUN_LIST_LIMIT, runStatuses, type ListRunsInput, type RunStatus } from './store';

// ── GET /api/runs — issue #135 ──────────────────────────────────────────────────────────────

/** The default page size when `limit` is omitted. */
const DEFAULT_RUN_LIST_LIMIT = 20;

/**
 * A `(created_at, id)` pagination boundary, opaque to every client: base64url of a small JSON
 * object. Never a raw offset — an offset is exactly what stops being stable the moment a row is
 * inserted or deleted ahead of it, which is the property issue #135 asks this pagination to have.
 *
 * `cursor.createdAt` is carried through **as the string the store minted it as** — never parsed
 * into, or built from, a `Date`. `./store.ts`'s `RunListCursor` doc comment says why: a `Date`
 * only survives to millisecond precision, `runs.created_at` is microsecond precision, and this
 * function used to call `.toISOString()` here, which is exactly where round 2 finding 1's
 * truncation happened — silently, on every single cursor this route ever minted.
 */
export function encodeRunListCursor(cursor: {
  readonly createdAt: string;
  readonly id: string;
}): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

/**
 * The exact text a `from`/`to` query parameter may take: `YYYY-MM-DDTHH:MM:SS`, an optional
 * fractional part of one to three digits, then a mandatory zone — `Z` or `±HH:MM`. Three digits
 * because a `Date` (the type both stores compare against) carries nothing finer, and a fourth
 * digit silently dropped would move `from` onto rows the caller asked to exclude. A mandatory
 * zone because a zone-less timestamp is read in the web process's own time zone, so the same
 * request answered different rows on instances configured differently (round 4 finding 5).
 */
const RUN_LIST_BOUND =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

/**
 * The instants a `from`/`to` bound may name: years 0001–9999 UTC. PostgreSQL reads further in
 * both directions, but every `Date` the query binds is serialised by `toISOString`, which prints
 * a year outside that range in the signed six-digit form (`+010000-…`) PostgreSQL refuses — the
 * cause of round 4 finding 2's thrown queries. Checked on the UTC instant, after any offset is
 * applied, because `9999-12-31T23:00:00-02:00` is already year 10000.
 */
const EARLIEST_RUN_LIST_BOUND = ((): number => {
  const instant = new Date(0);
  instant.setUTCFullYear(1, 0, 1);
  instant.setUTCHours(0, 0, 0, 0);
  return instant.getTime();
})();
const LATEST_RUN_LIST_BOUND = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** The one sentence `invalid_from` and `invalid_to` both explain the shape with. */
const RUN_LIST_BOUND_REQUIREMENT =
  'must be an ISO-8601 timestamp with an explicit zone (YYYY-MM-DDTHH:MM:SS[.fff]Z or ' +
  '±HH:MM) in years 0001–9999.';

/**
 * Parse a `from`/`to` query parameter, or `null` for anything outside {@link RUN_LIST_BOUND} and
 * {@link EARLIEST_RUN_LIST_BOUND}–{@link LATEST_RUN_LIST_BOUND}. A positive assertion in the
 * ADR-0015 shape: the value is admitted because it names an instant the query can bind, never
 * because `new Date(text)` happened not to be `NaN` — that gate admitted `"1"`, `"2026"`, a
 * signed six-digit year, year 0 and a zone-less timestamp (round 4 findings 2 and 5).
 */
function parseRunListBound(text: string): Date | null {
  const match = RUN_LIST_BOUND.exec(text);
  if (match === null) return null;
  const fraction = match[7];
  const utc = instantOfUtcFields({
    year: digitGroup(match, 1),
    month: digitGroup(match, 2),
    day: digitGroup(match, 3),
    hour: digitGroup(match, 4),
    minute: digitGroup(match, 5),
    second: digitGroup(match, 6),
    millisecond: fraction === undefined ? 0 : Number(fraction.padEnd(3, '0')),
  });
  if (utc === null) return null;
  let offsetMinutes = 0;
  if (match[8] === undefined) {
    // Not `Z`, so the `±HH:MM` alternative matched and all three of its groups are present.
    const sign = match[9];
    if (sign === undefined) throw new Error('timestamp zone sign is absent');
    const hours = digitGroup(match, 10);
    const minutes = digitGroup(match, 11);
    if (hours > 23 || minutes > 59) return null;
    offsetMinutes = (sign === '-' ? -1 : 1) * (hours * 60 + minutes);
  }
  const instant = utc.getTime() - offsetMinutes * 60_000;
  if (instant < EARLIEST_RUN_LIST_BOUND || instant > LATEST_RUN_LIST_BOUND) return null;
  return new Date(instant);
}

type CursorParseResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly cursor: { readonly createdAt: string; readonly id: string } }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Decode a `cursor` query parameter. **Never falls back to "start over"**: the same ADR-0015
 * shape `./cursor.ts`'s resume cursor uses — a malformed cursor a client believes is valid must be
 * refused by name, not silently answered with page one re-served as if it were the next page.
 */
function decodeRunListCursor(raw: string | null): CursorParseResult {
  if (raw === null) return { kind: 'absent' };
  let text: string;
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return { kind: 'invalid', reason: 'the cursor is not valid base64url.' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'invalid', reason: 'the cursor does not decode to JSON.' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'invalid', reason: 'the cursor must decode to a JSON object.' };
  }
  const record = value as Record<string, unknown>;
  const createdAtRaw = record['createdAt'];
  const id = record['id'];
  if (typeof createdAtRaw !== 'string' || !isUuid(id)) {
    return {
      kind: 'invalid',
      reason: 'the cursor must carry a "createdAt" timestamp string and an "id" UUID.',
    };
  }
  // Validated against the exact shape the stores mint, and then passed on as the raw string, at
  // whatever precision the minting store actually used — never re-rendered through a `Date`.
  if (!isKeysetTimestamp(createdAtRaw)) {
    return {
      kind: 'invalid',
      reason:
        'the cursor "createdAt" is not a UTC timestamp of the form YYYY-MM-DDTHH:MM:SS.ffffffZ.',
    };
  }
  return { kind: 'ok', cursor: { createdAt: createdAtRaw, id } };
}

export type RunListQueryResult =
  | { readonly kind: 'ok'; readonly input: ListRunsInput }
  | {
      readonly kind: 'rejected';
      readonly status: number;
      readonly code: string;
      readonly reason: string;
    };

/**
 * Parse and validate every `GET /api/runs` query parameter, including the authorisation rule
 * issue #135 states as a "deliberately not built": the `user` filter exists only for a caller
 * whose grant is `any` (Owner and Admin, under the current `runs` classification — see
 * `api.ts`'s header).
 * A grant of `own` gets the same filter applied, but as an unconditional fact about the query
 * rather than an offered parameter: {@link decideRunListAccess} already established that this
 * caller may only ever see their own rows, so nothing here trusts the caller to ask correctly.
 */
export function parseRunListQuery(
  url: URL,
  grant: Grant,
  principal: RunPrincipal,
): RunListQueryResult {
  const params = url.searchParams;
  const reject = (status: number, code: string, reason: string): RunListQueryResult => ({
    kind: 'rejected',
    status,
    code,
    reason,
  });

  const rawLimit = params.get('limit');
  let limit = DEFAULT_RUN_LIST_LIMIT;
  if (rawLimit !== null) {
    if (!/^[1-9]\d{0,3}$/.test(rawLimit)) {
      return reject(400, 'invalid_limit', 'limit must be a positive integer.');
    }
    limit = Number(rawLimit);
    if (limit > MAX_RUN_LIST_LIMIT) {
      return reject(400, 'invalid_limit', `limit must not exceed ${String(MAX_RUN_LIST_LIMIT)}.`);
    }
  }

  const cursor = decodeRunListCursor(params.get('cursor'));
  if (cursor.kind === 'invalid') return reject(400, 'invalid_cursor', cursor.reason);

  const filter: {
    status?: RunStatus;
    agentId?: string;
    projectId?: string;
    provider?: ModelProvider;
    model?: string;
    createdFrom?: Date;
    createdTo?: Date;
    initiatingUserId?: string;
    ownerPrincipalId?: string;
  } = {};

  const status = params.get('status');
  if (status !== null) {
    if (!(runStatuses as readonly string[]).includes(status)) {
      return reject(400, 'invalid_status', `status must be one of: ${runStatuses.join(', ')}.`);
    }
    filter.status = status as RunStatus;
  }

  const agent = params.get('agent');
  if (agent !== null) {
    if (!isUuid(agent)) return reject(400, 'invalid_agent', 'agent must be a UUID.');
    filter.agentId = agent;
  }

  const project = params.get('project');
  if (project !== null) {
    if (!isUuid(project)) return reject(400, 'invalid_project', 'project must be a UUID.');
    filter.projectId = project;
  }

  const provider = params.get('provider');
  if (provider !== null) {
    if (!(MODEL_PROVIDERS as readonly string[]).includes(provider)) {
      return reject(
        400,
        'invalid_provider',
        `provider must be one of: ${MODEL_PROVIDERS.join(', ')}.`,
      );
    }
    filter.provider = provider as ModelProvider;
  }

  const model = params.get('model');
  if (model !== null) {
    if (model.trim().length === 0) return reject(400, 'invalid_model', 'model must not be empty.');
    filter.model = model;
  }

  const from = params.get('from');
  if (from !== null) {
    const createdFrom = parseRunListBound(from);
    if (createdFrom === null) {
      return reject(400, 'invalid_from', `from ${RUN_LIST_BOUND_REQUIREMENT}`);
    }
    filter.createdFrom = createdFrom;
  }

  const to = params.get('to');
  if (to !== null) {
    const createdTo = parseRunListBound(to);
    if (createdTo === null) return reject(400, 'invalid_to', `to ${RUN_LIST_BOUND_REQUIREMENT}`);
    if (filter.createdFrom !== undefined && createdTo.getTime() < filter.createdFrom.getTime()) {
      return reject(400, 'invalid_date_range', 'to must not be before from.');
    }
    filter.createdTo = createdTo;
  }

  const user = params.get('user');
  if (user !== null) {
    if (grant !== 'any') {
      return reject(
        403,
        'user_filter_forbidden',
        'the "user" filter is available only to a role with workspace-wide run read access.',
      );
    }
    if (!isUuid(user)) return reject(400, 'invalid_user', 'user must be a UUID.');
    filter.initiatingUserId = user;
  } else if (grant !== 'any') {
    // `decide()`'s own words for `own` on a collection route: the caller "owes the result set the
    // filter" (`rbac/decide.ts`). Paid unconditionally, so a Builder or Viewer request can never
    // widen past their own runs no matter what else it asks for.
    filter.ownerPrincipalId = ownerPrincipalIdOf(principal);
  }

  return {
    kind: 'ok',
    input: { filter, limit, cursor: cursor.kind === 'ok' ? cursor.cursor : null },
  };
}
