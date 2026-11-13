import { type AgentCreatedAuditDetails } from '@indx-workspace/contracts/observability';
import type { AgentResourceStoreProvider } from '../../agents/resource-store';
import { type AgentStoreProvider } from '../../agents/store';
import type { LatestEvaluation } from '../release';
import {
  type AgentDefinitionReferenceKind,
  type AgentPointerAudit,
  type AgentVersionPointerRecord,
  type AgentVersionStoreProvider,
  type FileGrant,
  type StorageGrantRef,
} from '../store';
/** A row a definition name may match: its id and the name (a file's path) it is known by. */
export interface SeededReference {
  readonly id: string;
  readonly name: string;
  /** A connector that launches a process (`transport: stdio`), not one reached over a URL. */
  readonly stdio?: boolean;
  /** A tool connector (`openapi`/`postgres`), not an MCP one. */
  readonly tool?: boolean;
  /** A skill whose delete is under way: it does not resolve and answers `skill_deleting`. */
  readonly deleting?: boolean;
}

/** The rows each reference kind may match, for one workspace. */
export type SeededReferences = Partial<
  Record<AgentDefinitionReferenceKind, readonly SeededReference[]>
>;

export interface InMemoryAgentVersionStoreOptions {
  /** The agents a version may belong to — `create` and `list` answer "no agent" for any other id. */
  readonly agents: AgentStoreProvider;
  /**
   * The legacy assignment store a route test reads, which a `local` materialisation also writes —
   * in PostgreSQL both read the same three tables (issue #616).
   */
  readonly resources?: AgentResourceStoreProvider;
  /** The named rows each workspace holds, keyed by workspace id. */
  readonly references?: Readonly<Record<string, SeededReferences>>;
  /**
   * Each workspace's default runtime profile id (the profile marked `runtime_profiles.workspace_default`), keyed by
   * workspace id. A workspace absent here has no default, so a null `runtimeProfileName` resolves
   * to `null`.
   */
  readonly defaultRuntimeProfiles?: Readonly<Record<string, string>>;
  /** The principal ids `create` accepts; `undefined` accepts any (the foreign-key mirror). */
  readonly knownPrincipalIds?: ReadonlySet<string>;
  /**
   * Whether a storage connection of the workspace still exists. In PostgreSQL deleting a connection
   * cascades every version's grant rows on it (`agent_version_storage_grants`), so a version's
   * grants never name a deleted connection; this mirrors that cascade on read. Absent, every
   * connection a grant names is taken to exist.
   */
  readonly connectionExists?: (workspaceId: string, connectionId: string) => Promise<boolean>;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** A pointer row as the memory store keeps it: the record plus its workspace. */
export type SeededPointer = AgentVersionPointerRecord & { readonly workspaceId: string };

/** An `agent-changed` audit row as the memory store records it — the `audit_events` mirror. */
export type RecordedPointerAudit = AgentPointerAudit & {
  readonly workspaceId: string;
  readonly action: 'agent-changed' | 'storage-grant-changed' | 'agent-created';
  readonly subjectId: string;
  /** Set on an `agent-created` row only. */
  readonly details?: AgentCreatedAuditDetails;
};

/** The provider plus what a test reads back: how many versions and pointers exist. */
export interface InMemoryAgentVersionStoreProvider extends AgentVersionStoreProvider {
  /** Every version row in every workspace. */
  versionCount(): number;
  /** Every pointer row in every workspace. */
  pointerCount(): number;
  /** Every `agent-changed` row an applied pointer move recorded, oldest first. */
  audits(): readonly RecordedPointerAudit[];
  /**
   * Seed a pointer directly, without materialising the version (a listing test's shortcut). It
   * records a `set` move with no mover, as the migration's backfill does.
   */
  point(pointer: SeededPointer): void;
  /** The assignments the last materialisation wrote for `agentId`, or `undefined` if none. */
  assignmentsOf(agentId: string): MaterialisedAssignments | undefined;
  /** Seed an evaluation of the version with id `versionId`; the newest seeded is the latest. */
  recordEvaluation(versionId: string, evaluation: LatestEvaluation): void;
}

/** What a materialisation writes beside the agent row: core's three assignment tables. */
export interface MaterialisedAssignments {
  readonly skillIds: readonly string[];
  readonly skillRevisions?: Readonly<Record<string, number>> | undefined;
  readonly connectorIds: readonly string[];
  /** After the #133 ceiling: `read-write` only when the agent may write files. */
  readonly files: readonly FileGrant[];
  /** After the same ceiling, with the connection ids the deploy resolved. */
  readonly storageGrants: readonly StorageGrantRef[];
}
