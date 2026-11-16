import { eq } from 'drizzle-orm';

import {
  agents,
  parseAgentPermissions,
  parseAgentPolicy,
  parseBuiltinKey,
} from '../../schema/agents.js';
import type {
  AgentRecord,
  CreateAgentOutcome,
  CreateAgentWithAssignmentsOutcome,
} from '../agents.js';
import { postgresViolations } from '../violations.js';
import type { AgentContext } from './context.js';

/**
 * The constraint names this module knows how to turn into an outcome.
 *
 * Transcribed from `migrations/0000_init.sql`, which is the artefact PostgreSQL actually reports.
 * `agents_workspace_name_key` is a unique *index*; PostgreSQL still reports its name in the
 * error's `constraint` field, which is why it can be matched the same way as the two foreign keys.
 */
const NAME_CONFLICT_CONSTRAINTS: ReadonlySet<string> = new Set(['agents_workspace_name_key']);
const MODEL_CONNECTION_CONSTRAINTS: ReadonlySet<string> = new Set([
  'agents_model_connection_id_model_connections_id_fk',
  'agents_model_connection_workspace_fk',
]);
const RUNTIME_PROFILE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'agents_runtime_profile_id_runtime_profiles_id_fk',
  'agents_runtime_profile_workspace_fk',
]);

/** PostgreSQL SQLSTATE classes this module classifies. Anything else is somebody else's problem. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Classify a write failure, or answer `null`.
 *
 * Positive assertion, twice over: a failure is a name conflict because its SQLSTATE was
 * `23505` **and** its constraint was one of the names above. A `null` return means "this module
 * does not know what this is", and every caller re-throws on it rather than reporting a plausible
 * client error for a failure that might be a dropped connection (ADR-0015).
 */
function classifyWriteFailure(
  error: unknown,
): 'name-conflict' | 'unknown-model-connection' | 'unknown-runtime-profile' | null {
  for (const failure of postgresViolations(error)) {
    if (failure.code === UNIQUE_VIOLATION && NAME_CONFLICT_CONSTRAINTS.has(failure.constraint)) {
      return 'name-conflict';
    }
    if (
      failure.code === FOREIGN_KEY_VIOLATION &&
      MODEL_CONNECTION_CONSTRAINTS.has(failure.constraint)
    ) {
      return 'unknown-model-connection';
    }
    if (
      failure.code === FOREIGN_KEY_VIOLATION &&
      RUNTIME_PROFILE_CONSTRAINTS.has(failure.constraint)
    ) {
      return 'unknown-runtime-profile';
    }
  }
  return null;
}

/** The values a refused write attempted, as its outcome names them. */
interface AttemptedWrite {
  readonly name?: string;
  readonly modelConnectionId?: string | null;
  readonly runtimeProfileId?: string | null;
}

/**
 * The outcome a classified write failure reports, naming the value the write attempted; re-throws
 * `error` when {@link classifyWriteFailure} does not recognise it.
 */
export function writeFailureOutcome(
  error: unknown,
  attempted: AttemptedWrite,
): Exclude<CreateAgentOutcome, { readonly kind: 'created' }> {
  const classified = classifyWriteFailure(error);
  if (classified === 'name-conflict') return { kind: 'name-conflict', name: attempted.name ?? '' };
  if (classified === 'unknown-model-connection') {
    return {
      kind: 'unknown-model-connection',
      modelConnectionId: attempted.modelConnectionId ?? '',
    };
  }
  if (classified === 'unknown-runtime-profile') {
    return {
      kind: 'unknown-runtime-profile',
      runtimeProfileId: attempted.runtimeProfileId ?? '',
    };
  }
  throw error;
}

/** The columns a read selects. Written out so a schema change that drops one is a compile error. */
export const AGENT_COLUMNS = {
  id: agents.id,
  workspaceId: agents.workspaceId,
  name: agents.name,
  instructions: agents.instructions,
  modelConnectionId: agents.modelConnectionId,
  model: agents.model,
  runtimeProfileId: agents.runtimeProfileId,
  permissions: agents.permissions,
  policy: agents.policy,
  createdBy: agents.createdBy,
  ownerPrincipalId: agents.ownerPrincipalId,
  builtinKey: agents.builtinKey,
  createdByAgentId: agents.createdByAgentId,
  createdByAgentVersion: agents.createdByAgentVersion,
  createdByRunId: agents.createdByRunId,
  archivedAt: agents.archivedAt,
  createdAt: agents.createdAt,
  updatedAt: agents.updatedAt,
} as const;

/** One selected row into an {@link AgentRecord}, parsing `permissions` rather than trusting it. */
export function toRecord(row: {
  id: string;
  workspaceId: string;
  name: string;
  instructions: string;
  modelConnectionId: string | null;
  model: string | null;
  runtimeProfileId: string | null;
  permissions: unknown;
  policy: unknown;
  createdBy: string | null;
  ownerPrincipalId: string;
  builtinKey: string | null;
  createdByAgentId: string | null;
  createdByAgentVersion: number | null;
  createdByRunId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): AgentRecord {
  const builtin = parseBuiltinKey(row.builtinKey);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    instructions: row.instructions,
    modelConnectionId: row.modelConnectionId,
    model: row.model,
    runtimeProfileId: row.runtimeProfileId,
    permissions: parseAgentPermissions(row.permissions),
    policy: parseAgentPolicy(row.policy),
    createdBy: row.createdBy,
    ownerPrincipalId: row.ownerPrincipalId,
    ...(builtin === undefined ? {} : { builtin }),
    // The lineage CHECK makes the version and the run both present or both absent.
    ...(row.createdByAgentVersion === null || row.createdByRunId === null
      ? {}
      : {
          createdByAgent: {
            agentId: row.createdByAgentId,
            version: row.createdByAgentVersion,
            runId: row.createdByRunId,
          },
        }),
    ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** One agent in this workspace by id, or `null` if this workspace has no agent with that id. */
export async function selectAgent(
  { db, within }: AgentContext,
  id: string,
): Promise<AgentRecord | null> {
  const rows = await db
    .select(AGENT_COLUMNS)
    .from(agents)
    .where(within(eq(agents.id, id)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

/** Thrown inside a transaction to roll it back, and caught by the method that threw it. */
export class Rollback extends Error {
  constructor(readonly outcome: Exclude<CreateAgentWithAssignmentsOutcome, { kind: 'created' }>) {
    super(`agent create rolled back: ${outcome.kind}`);
  }
}
