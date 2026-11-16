/** How the agent version writes name their failures; see `./agent-versions-write.ts`. */
import type {
  CreateAgentVersionOutcome,
  CreateAgentWithFirstVersionOutcome,
  PointerMovedOutcome,
  ReferenceGoneOutcome,
  SubagentNestingOutcome,
} from './agent-versions.js';
import type { AgentDefinitionReferenceKind } from './agent-versions-resolution.js';
import { postgresViolations } from './violations.js';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

/** Foreign keys whose violation means "a resolved reference is gone", by reference kind. */
const REFERENCE_CONSTRAINTS: ReadonlyMap<string, AgentDefinitionReferenceKind> = new Map([
  ['agent_skills_skill_workspace_fk', 'skill'],
  ['agent_skills_skill_revision_fk', 'skill'],
  ['agent_mcp_servers_server_workspace_fk', 'connector'],
  ['agent_files_file_workspace_fk', 'file'],
  ['agents_model_connection_id_model_connections_id_fk', 'model-connection'],
  ['agents_model_connection_workspace_fk', 'model-connection'],
  ['agents_runtime_profile_id_runtime_profiles_id_fk', 'runtime-profile'],
  ['agents_runtime_profile_workspace_fk', 'runtime-profile'],
]);
/** A second built-in of one kind (`agents_workspace_builtin_key`) is the same refusal as a taken name. */
const NAME_CONFLICT_CONSTRAINTS: ReadonlySet<string> = new Set([
  'agents_workspace_name_key',
  'agents_workspace_builtin_key',
]);
/** Foreign keys whose violation means "this principal is not one of this workspace's". */
const UNKNOWN_PRINCIPAL_CONSTRAINTS: ReadonlySet<string> = new Set([
  'agent_versions_created_by_principal_workspace_fk',
  'agents_owner_principal_workspace_fk',
]);
/** The lineage foreign keys: the creating agent does not exist, or is not one of this workspace's. */
const UNKNOWN_CREATOR_AGENT_CONSTRAINTS = new Set([
  'agents_created_by_agent_id_agents_id_fk',
  'agents_created_by_agent_workspace_fk',
]);
/** A half-set lineage is refused the same way: the creator cannot be recorded. */
const LINEAGE_CHECK = 'agents_created_by_agent_lineage_check';

type WriteFailure =
  | { readonly kind: 'name-conflict' }
  | { readonly kind: 'reference-gone'; readonly referenceKind: AgentDefinitionReferenceKind }
  | { readonly kind: 'unknown-principal' }
  | { readonly kind: 'unknown-creator-agent' };

/** Classify a write failure by SQLSTATE and constraint name, or answer `null` (ADR-0015). */
function classifyWriteFailure(error: unknown): WriteFailure | null {
  for (const failure of postgresViolations(error)) {
    if (failure.code === UNIQUE_VIOLATION && NAME_CONFLICT_CONSTRAINTS.has(failure.constraint)) {
      return { kind: 'name-conflict' };
    }
    if (failure.code === CHECK_VIOLATION && failure.constraint === LINEAGE_CHECK) {
      return { kind: 'unknown-creator-agent' };
    }
    if (failure.code !== FOREIGN_KEY_VIOLATION) continue;
    const referenceKind = REFERENCE_CONSTRAINTS.get(failure.constraint);
    if (referenceKind !== undefined) return { kind: 'reference-gone', referenceKind };
    if (UNKNOWN_PRINCIPAL_CONSTRAINTS.has(failure.constraint)) return { kind: 'unknown-principal' };
    if (UNKNOWN_CREATOR_AGENT_CONSTRAINTS.has(failure.constraint)) {
      return { kind: 'unknown-creator-agent' };
    }
  }
  return null;
}

/** The non-applied outcomes raised inside a transaction so that it rolls back. */
type RollbackOutcome =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'agent-archived' }
  | { readonly kind: 'version-not-found' }
  | { readonly kind: 'surface-name-taken'; readonly name: string }
  | { readonly kind: 'reference-gone'; readonly referenceKind: AgentDefinitionReferenceKind }
  | PointerMovedOutcome
  | SubagentNestingOutcome;

/** Private to the write modules: thrown inside a transaction to roll it back, and caught by the method that threw it. */
export class Rollback extends Error {
  constructor(readonly outcome: RollbackOutcome) {
    super(`agent version transaction rolled back: ${outcome.kind}`);
    this.name = 'Rollback';
  }
}

/** Map a failed write to an outcome, or re-throw what this module cannot name. */
export function referenceGoneOrNameConflict(
  error: unknown,
  name: string,
): { readonly kind: 'name-conflict'; readonly name: string } | ReferenceGoneOutcome {
  const failure = classifyWriteFailure(error);
  if (failure?.kind === 'name-conflict') return { kind: 'name-conflict', name };
  if (failure?.kind === 'reference-gone') {
    return { kind: 'reference-gone', referenceKind: failure.referenceKind };
  }
  throw error;
}

/** Map a failed version insert to `unknown-principal`, or re-throw it. */
export function createVersionFailure(error: unknown): CreateAgentVersionOutcome {
  if (classifyWriteFailure(error)?.kind === 'unknown-principal') {
    return { kind: 'unknown-principal' };
  }
  throw error;
}

/** Map a failed agent creation (named `name`) to its outcome, or re-throw it. */
export function createAgentFailure(
  error: unknown,
  name: string,
): CreateAgentWithFirstVersionOutcome {
  if (error instanceof Rollback) {
    if (
      error.outcome.kind === 'surface-name-taken' ||
      error.outcome.kind === 'subagent-nesting' ||
      error.outcome.kind === 'reference-gone'
    ) {
      return error.outcome;
    }
    throw error;
  }
  const failure = classifyWriteFailure(error);
  if (failure?.kind === 'unknown-principal' || failure?.kind === 'unknown-creator-agent') {
    return { kind: failure.kind };
  }
  return referenceGoneOrNameConflict(error, name);
}
