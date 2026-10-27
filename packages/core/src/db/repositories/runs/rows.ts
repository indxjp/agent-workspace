import { and, sql, type SQL } from 'drizzle-orm';

import { agentVersions } from '../../schema/agent-versions.js';
import { engineIds, type EngineId } from '../../schema/agents.js';
import {
  accountingStates,
  runs,
  runStatuses,
  stoppedRunStatuses,
  terminalRunStatuses,
  type AccountingState,
  type RunStatus,
} from '../../schema/runs.js';
import { sessions } from '../../schema/sessions.js';
import { postgresViolations } from '../violations.js';
import type { ApprovalCall, RunOutput, RunRecord } from './types.js';

/** The statuses at which a run is over, as a set, so membership is a lookup and not a scan. */
const TERMINAL: ReadonlySet<string> = new Set(terminalRunStatuses);

/** The statuses at which a run has ended (terminal, or paused at a decision), as a set. */
export const STOPPED: ReadonlySet<string> = new Set(stoppedRunStatuses);

/** True for a status at which the run is over and `ended_at` must be set. */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * The statuses a run may move to `to` from — the one owner of the transition rule, used as the
 * `where status in (…)` of every conditional update, so a lost race is a no-op and not an overwrite.
 *
 * A paused run (`awaiting_approval`) never goes back to `running`: the continuation is a new run in
 * the same session (ADR-0145 D1). `failed` is not reachable from it either — a decision resolves a
 * pause to `completed` or `cancelled`.
 */
export function runStatusesThatMayMoveTo(to: RunStatus): readonly RunStatus[] {
  switch (to) {
    case 'running':
      return ['queued'];
    case 'awaiting_approval':
      return ['running'];
    case 'completed':
    case 'cancelled':
      return ['queued', 'running', 'awaiting_approval'];
    case 'failed':
      return ['queued', 'running'];
    case 'queued':
      return [];
    default: {
      const unreachable: never = to;
      throw new Error(`unhandled run status ${String(unreachable)}`);
    }
  }
}

/** The canonical textual UUID, the only form a `uuid` parameter is bound in. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Whether a stored `uuid[]` holds exactly the ids of a canonical (sorted, distinct) set. */
export function sameIdSet(stored: readonly string[], canonical: readonly string[]): boolean {
  const sorted = [...new Set(stored)].sort();
  return sorted.length === canonical.length && sorted.every((id, i) => id === canonical[i]);
}

// ── Failure classification ──────────────────────────────────────────────────────────────────
//
// Transcribed from `migrations/0000_init.sql`, which is what PostgreSQL reports back.

export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';

export const RUN_PRIMARY_KEY = 'runs_pkey';
/** The index that makes a start key single-use per workspace and principal (ADR-0151). */
export const RUN_IDEMPOTENCY_KEY_INDEX = 'runs_workspace_idempotency_key_unique';
/** The index that gives a paused run at most one continuation (ADR-0151). */
export const RUN_CONTINUATION_INDEX = 'runs_continues_run_id_unique';

/** The stored form of a start key: scoped to its principal by prefixing the principal's id. */
export const scopedIdempotencyKey = (principalId: string, key: string): string =>
  `${principalId}:${key}`;
export const RUN_SESSION_CONSTRAINT = 'runs_session_workspace_fk';
export const SESSION_PRIMARY_KEY = 'sessions_pkey';
export const SESSION_AGENT_CONSTRAINT = 'sessions_agent_workspace_fk';
export const SESSION_MEMBER_CONSTRAINT = 'sessions_member_workspace_fk';
export const SESSION_OWNER_CONSTRAINT = 'sessions_owner_principal_workspace_fk';

/**
 * True when some link of the thrown error's `cause` chain is this SQLSTATE on this constraint.
 *
 * A positive assertion about a named constraint, never "the write failed so it must have been
 * the obvious reason". A caller for which every `violatedBy` answers `false` re-throws: a failure
 * this module cannot name might be a dropped connection, and reporting it as a client error would
 * be a gate deciding on the absence of a negative (ADR-0015). The chain walk is in
 * `./violations.ts`, together with the measurement that showed it was needed.
 */
export function violatedBy(error: unknown, code: string, constraint: string): boolean {
  for (const failure of postgresViolations(error)) {
    if (failure.code === code && failure.constraint === constraint) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One approval call, narrowed by a positive assertion. Persisted JSON and caller input are
 * `unknown` until this accepts them: exactly `toolName` and `canonicalCall`, both non-empty text.
 */
export function parseApprovalCall(value: unknown): ApprovalCall {
  if (!isRecord(value)) throw new Error('an approval call must be an object');
  const keys = Object.keys(value);
  const { toolName, canonicalCall } = value;
  if (
    keys.length !== 2 ||
    !keys.includes('toolName') ||
    !keys.includes('canonicalCall') ||
    typeof toolName !== 'string' ||
    toolName.length === 0 ||
    typeof canonicalCall !== 'string' ||
    canonicalCall.length === 0
  ) {
    throw new Error(
      'an approval call is exactly { toolName, canonicalCall }, both non-empty strings',
    );
  }
  return { toolName, canonicalCall };
}

/** {@link parseApprovalCall} over an array. */
export function parseApprovalCalls(value: unknown): readonly ApprovalCall[] {
  if (!Array.isArray(value)) throw new Error('approved tool calls must be an array');
  return value.map(parseApprovalCall);
}

/** The columns a run read selects, with `agent_id` reached through the session. */
export const RUN_COLUMNS = {
  id: runs.id,
  workspaceId: runs.workspaceId,
  agentId: sessions.agentId,
  sessionId: runs.sessionId,
  status: runs.status,
  createdAt: runs.createdAt,
  startedAt: runs.startedAt,
  endedAt: runs.endedAt,
  model: runs.model,
  provider: runs.provider,
  modelConnectionId: runs.modelConnectionId,
  toolConnectorIds: runs.toolConnectorIds,
  fileGrants: runs.fileGrants,
  toolSandboxOrigin: runs.toolSandboxOrigin,
  pendingApproval: runs.pendingApproval,
  approvedToolCalls: runs.approvedToolCalls,
  approvalsConsumedAt: runs.approvalsConsumedAt,
  consumedToolCalls: runs.consumedToolCalls,
  engine: runs.engine,
  engineVersion: runs.engineVersion,
  inputTokens: runs.inputTokens,
  outputTokens: runs.outputTokens,
  cacheReadInputTokens: runs.cacheReadInputTokens,
  cacheCreationInputTokens: runs.cacheCreationInputTokens,
  toolCalls: runs.toolCalls,
  costUsd: runs.costUsd,
  costCurrency: runs.costCurrency,
  priceTableVersion: runs.priceTableVersion,
  error: runs.error,
  accountingState: runs.accountingState,
  accountingError: runs.accountingError,
  // Reached through the same join as `agentId` above, for the same reason: neither is a column on
  // `runs`, and a second copy here could disagree with `sessions`'.
  projectId: sessions.projectId,
  initiatingUserId: sessions.userId,
  ownerPrincipalId: sessions.ownerPrincipalId,
  // The number of the version the session pins, through a LEFT JOIN on `sessions.agent_version_id`:
  // NULL for a legacy session that pins none. Never copied onto `runs`, where it could disagree.
  agentVersion: agentVersions.number,
  output: runs.output,
} as const;

/**
 * {@link RUN_COLUMNS} plus the one extra value only `listRuns` needs: the row's `created_at` at
 * the database's own precision, as text, for minting a keyset cursor that does not truncate it.
 * `RunRecord.createdAt` (from `RUN_COLUMNS` alone) stays a `Date` — everywhere else a run's
 * timestamp is a display value, not a pagination boundary, and `RunRecord`'s shape does not
 * change. Always UTC and always six fractional digits, so the text is both order-preserving
 * (lexicographic order on this format matches chronological order) and losslessly reversible with
 * a plain `::timestamptz` cast — see {@link RunListCursor}.
 */
export const LIST_RUN_COLUMNS = {
  ...RUN_COLUMNS,
  createdAtCursor: sql<string>`to_char(${runs.createdAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
} as const;

/**
 * A status read back from the database, narrowed by a positive assertion.
 *
 * `text('status', { enum: … })` is a compile-time narrowing; the row could hold anything the
 * `runs_status_valid` check allows, and a future migration relaxing that check would let an
 * unknown status through typed as a known one. Parsed here instead, with an explicit else.
 */
export function parseRunStatus(value: string): RunStatus {
  const known = (runStatuses as readonly string[]).includes(value);
  if (!known) throw new Error(`runs.status holds ${JSON.stringify(value)}, which is not a status`);
  return value as RunStatus;
}

/** Same positive-assertion narrowing as {@link parseRunStatus}, for `runs.accounting_state`. */
export function parseAccountingState(value: string): AccountingState {
  const known = (accountingStates as readonly string[]).includes(value);
  if (!known) {
    throw new Error(`runs.accounting_state holds ${JSON.stringify(value)}, which is not a state`);
  }
  return value as AccountingState;
}

/**
 * Same positive-assertion narrowing as {@link parseRunStatus}, for `runs.engine` — which, unlike
 * the two above, is legitimately NULL on a run recorded before migration 0024 added the column.
 */
function parseEngineId(value: string | null): EngineId | null {
  if (value === null) return null;
  const known = (engineIds as readonly string[]).includes(value);
  if (!known) throw new Error(`runs.engine holds ${JSON.stringify(value)}, which is not an engine`);
  return value as EngineId;
}

/** `runs.output` is persisted JSON: null, or `{ text: string, structured }`; anything else throws. */
function parseRunOutput(value: unknown): RunOutput | null {
  if (value === null) return null;
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'text' in value &&
    typeof value.text === 'string' &&
    'structured' in value
  ) {
    return { text: value.text, structured: value.structured };
  }
  throw new Error('runs.output holds a value that is not { text, structured }');
}

/** `runs.output_schema` is persisted JSON: null or an object; anything else throws. */
function parseOutputSchema(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error('runs.output_schema holds a value that is not a JSON Schema object');
}

export function toRunRecord(row: {
  id: string;
  workspaceId: string;
  agentId: string;
  sessionId: string;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  model: string | null;
  provider: string | null;
  modelConnectionId: string | null;
  toolConnectorIds: string[];
  fileGrants: string[];
  toolSandboxOrigin: string | null;
  pendingApproval: unknown;
  approvedToolCalls: unknown;
  approvalsConsumedAt: Date | null;
  consumedToolCalls: unknown;
  engine: string | null;
  engineVersion: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  toolCalls: number;
  costUsd: string;
  costCurrency: string;
  priceTableVersion: string | null;
  error: string | null;
  accountingState: string;
  accountingError: string | null;
  projectId: string | null;
  initiatingUserId: string | null;
  agentVersion: number | null;
  output: unknown;
  outputSchema?: unknown;
  prompt?: string | null;
  subject?: string | null;
}): RunRecord {
  if (row.costCurrency !== 'USD') {
    throw new Error(
      `runs.cost_currency holds unsupported currency ${JSON.stringify(row.costCurrency)}`,
    );
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    sessionId: row.sessionId,
    status: parseRunStatus(row.status),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    model: row.model,
    provider: row.provider,
    modelConnectionId: row.modelConnectionId,
    toolConnectorIds: [...row.toolConnectorIds],
    fileGrants: [...row.fileGrants],
    toolSandboxOrigin: row.toolSandboxOrigin,
    pendingApproval: row.pendingApproval === null ? null : parseApprovalCall(row.pendingApproval),
    approvedToolCalls: parseApprovalCalls(row.approvedToolCalls),
    approvalsConsumedAt: row.approvalsConsumedAt,
    consumedToolCalls: parseApprovalCalls(row.consumedToolCalls),
    engine: parseEngineId(row.engine),
    engineVersion: row.engineVersion,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadInputTokens: row.cacheReadInputTokens,
    cacheCreationInputTokens: row.cacheCreationInputTokens,
    toolCalls: row.toolCalls,
    costUsd: row.costUsd,
    costCurrency: row.costCurrency,
    priceTableVersion: row.priceTableVersion,
    error: row.error,
    accountingState: parseAccountingState(row.accountingState),
    accountingError: row.accountingError,
    projectId: row.projectId,
    initiatingUserId: row.initiatingUserId,
    agentVersion: row.agentVersion,
    output: parseRunOutput(row.output),
    ...(row.outputSchema === undefined
      ? {}
      : { outputSchema: parseOutputSchema(row.outputSchema) }),
    ...(row.prompt === undefined ? {} : { prompt: row.prompt }),
    ...(row.subject === undefined ? {} : { subject: row.subject }),
  };
}

/**
 * `and()`, with a throw rather than a fallback if the conjunction cannot be built.
 *
 * Shared by both providers below, and every call site passes the tenant predicate first.
 * Drizzle types `and()` as possibly-undefined because it accepts an empty argument list;
 * degrading to `undefined` here would drop the whole `where` clause, tenant filter included —
 * the one failure this layer exists to make impossible — so the impossible arm throws instead of
 * quietly widening the query.
 */
export function every(...predicates: readonly SQL[]): SQL {
  const combined = and(...predicates);
  if (combined === undefined) throw new Error('the workspace predicate could not be built');
  return combined;
}
