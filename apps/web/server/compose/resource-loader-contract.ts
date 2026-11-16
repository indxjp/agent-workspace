import type {
  AgentPermissions,
  McpServerConfig,
  RunFileReference,
  RunSkillReference,
} from '@agent-workspace/run-protocol';
import {
  type AgentPermissionKey,
  type AgentResourceAssignmentsInput,
} from '@indx-workspace/contracts/agents';
import type { ConnectorsStoreProvider } from '../integrations';
import type {
  ResourceCatalogStoreProvider,
  StorageService,
  WorkspaceSkillsStoreProvider,
} from '../storage-and-sharing';

/** A granted directory: created in the sandbox, with no bytes of its own. */
interface RunDirectoryGrant {
  readonly kind: 'directory';
  readonly path: string;
  readonly access: 'read' | 'read-write';
}

/** What a run is told about one granted path: a file reference (no bytes) or a directory. */
type RunFileGrant = RunFileReference | RunDirectoryGrant;

/**
 * Opens the bytes of one referenced file, lazily: nothing is read until `open` is called. It rides
 * beside the references and is never serialised into the `/run` body.
 */
interface RunFileSource {
  /** The object's id, for a log line about it; `null` for an object in the old naming. */
  readonly objectId: string | null;
  /**
   * The object is a customer's, listed with a size but not hashed: the archive checks the size as
   * it streams and reports the digest, which goes into the `/run` body before it is sent.
   */
  readonly streamed?: true;
  open(): Promise<ReadableStream<Uint8Array> | null>;
}

/** The two reads a run makes of a connection's store; the object-store port satisfies it. */
interface RunConnectionStore {
  listPage(
    prefix: string,
    options: { readonly recursive: true; readonly cursor?: string },
  ): Promise<{
    readonly entries: readonly (
      | { readonly kind: 'file'; readonly key: string; readonly sizeBytes: number }
      | { readonly kind: 'folder'; readonly key: string }
    )[];
    readonly cursor: string | null;
  }>;
  read(key: string): Promise<{ readonly body: ReadableStream<Uint8Array> } | null>;
}

/**
 * The two calls a run's write-back makes of a connection's store; the object-store port satisfies
 * it. `signal` is the save's: once it aborts, the store's own SDK call is stopped, not only waited
 * out.
 */
interface RunWritableConnectionStore {
  read(
    key: string,
    options: { readonly signal: AbortSignal },
  ): Promise<{
    readonly body: ReadableStream<Uint8Array>;
    readonly meta: { readonly etag: string };
  } | null>;
  write(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: { readonly signal: AbortSignal } & (
      { readonly ifNoneMatch: '*' } | { readonly ifMatch: string }
    ),
  ): Promise<unknown>;
}

/** The storage grant a folder was delivered writable for: the connection by id, never by name. */
interface DeliveredStorageFolder {
  readonly connectionId: string;
  readonly prefix: string;
}

/** One storage connection of a workspace, as a run reads it (the storage design, §05). */
interface RunStorageConnections {
  get(
    workspaceId: string,
    connectionId: string,
  ): Promise<{
    readonly name: string;
    readonly allowedPrefixes: readonly string[];
    readonly writeAllowed: boolean;
  } | null>;
  /** A read-only store, opened with the credential as it is now. */
  open(workspaceId: string, connectionId: string): Promise<RunConnectionStore>;
  /**
   * A store that can write: opened only by the write-back of a `read-write` grant. `signal`
   * abandons the open once the save stops.
   */
  openWritable(
    workspaceId: string,
    connectionId: string,
    signal?: AbortSignal,
  ): Promise<RunWritableConnectionStore>;
}

/**
 * A tool connector of the run (ADR-0113 C16, C17), keyed by its SD13 server key. Compose turns it
 * into an `http` MCP server at the gateway once the run token exists.
 */
interface PendingToolConnector {
  readonly key: string;
  readonly connectorId: string;
  /** The connector's name, which a policy ceiling's `tools` allowlist names (C14). */
  readonly name: string;
  readonly operationNames: readonly string[];
  /**
   * The `mcp__<key>__<operation>` rules of this connector's write operations (ADR-0113 SD4): each
   * is implicitly `requireApproval`. Absent when the connector has no write.
   */
  readonly approvalRules?: readonly string[];
  /** The connector opted in to the identity assertion (ADR-0142 D1); its secret resolved at compose. */
  readonly identity?: true;
}

/** An MCP connector that opted in: the key that signs its assertion, and the audience it names. */
interface ConnectorIdentityKey {
  readonly connectorId: string;
  readonly key: string;
}

interface AgentRunResourceSelection {
  readonly files: readonly RunFileGrant[];
  /**
   * The agent's memory folder (ADR-0163) as read-write grants under `memory/`, its directory first.
   * Kept apart from `files` so a run's `fileScope` never narrows it; `withMemoryFiles` puts it in
   * place of anything else under `memory/`. Absent when the run keeps no memory.
   */
  readonly memoryFiles?: readonly RunFileGrant[];
  readonly skills: readonly RunSkillReference[];
  /**
   * The bytes of each file reference, by its path relative to the run's cwd (a skill file's is
   * {@link skillInboxPath}). Never part of the `/run` body. Absent means none.
   */
  readonly sources?: ReadonlyMap<string, RunFileSource>;
  /**
   * The grant behind each storage folder delivered `read-write`, by its path relative to the run's
   * cwd, so the write-back saves to the connection that was delivered. Never part of the `/run`
   * body. Absent means none.
   */
  readonly storageFolders?: ReadonlyMap<string, DeliveredStorageFolder>;
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  /**
   * The connector name behind each `mcpServers` key, for a policy ceiling's `tools` allowlist
   * (S2-04c). Absent means no names, so a `tools` ceiling drops every MCP entry (fails closed).
   */
  readonly connectorNames?: Readonly<Record<string, string>>;
  /**
   * The `mcpServers` key of each MCP connector by connector id (ADR-0113 SD13, #1109), for rewriting
   * a stored policy rule written against `connector-<id>`. Absent means no rewrite.
   */
  readonly connectorKeys?: Readonly<Record<string, string>>;
  /** The signing key of each opted-in MCP connector, by `mcpServers` key. Absent means none. */
  readonly connectorIdentities?: Readonly<Record<string, ConnectorIdentityKey>>;
  /** Sorted by connector id. Absent means none. */
  readonly toolConnectors?: readonly PendingToolConnector[];
}

/**
 * issue #125: the session's project's `project_files`/`project_mcp_servers` associations, read
 * by id only — the loader resolves what those ids mean (path, catalog row, credential) exactly
 * the same way it already does for an agent's own assignments. Kept this narrow (two lookups,
 * not a `ProjectFileRepositoryProvider`) so this module does not need to know how a workspace id
 * becomes a `WorkspaceScope`; the caller that already has one (`instrumentation-node.ts`) adapts
 * it. See `docs/adr/W9-PROJ-125-project-resources-narrow-never-widen.md`.
 */
interface ProjectResourceReader {
  listFileIds(workspaceId: string, projectId: string): Promise<readonly string[]>;
  listMcpServerIds(workspaceId: string, projectId: string): Promise<readonly string[]>;
}

interface AgentRunResourceLoader {
  /**
   * `assignments` are what the run's agent is assigned: its pinned version's, or the agent's own for
   * a legacy session (issue #612). `projectId`/`agentPermissions` are issue #125's addition and are optional so every pre-#125
   * call site (and this file's own pre-#125 tests) keeps compiling and behaving unchanged: no
   * project, no project resources. When a project is given, `agentPermissions` is the ceiling —
   * see {@link AgentRunResourceLoaderDependencies.projectResources}'s doc comment for what "no
   * permission" does. `ceilingCaps` are the switches the deployment's policy ceiling turned off
   * (S2-04c): a project resource refused for one of them is a typed `policy_cannot_widen` refusal
   * naming the ceiling, so the user sees why. `memoryAgentId` names the agent whose memory folder
   * the run keeps (ADR-0163); `null` or absent, none is read.
   */
  load(
    workspaceId: string,
    assignments: AgentResourceAssignmentsInput,
    projectId?: string | null,
    agentPermissions?: AgentPermissions,
    ceilingCaps?: readonly AgentPermissionKey[],
    memoryAgentId?: string | null,
  ): Promise<AgentRunResourceSelection>;
}

interface AgentRunResourceLoaderDependencies {
  readonly catalog: ResourceCatalogStoreProvider;
  /** The catalog service; a run with assigned files is refused without it. */
  readonly storage?: Pick<StorageService, 'open' | 'list'>;
  readonly skills?: WorkspaceSkillsStoreProvider;
  readonly connectors?: ConnectorsStoreProvider;
  /** issue #125. Omitted (or no project on the run) means no project resource is even attempted. */
  readonly projectResources?: ProjectResourceReader;
  /** The workspace's storage connections; absent means a storage grant refuses the run. */
  readonly storageConnections?: RunStorageConnections;
  /**
   * Catalog rows only, for a check before the run is queued (`run-preflight.ts`): each reference
   * carries its row's size and an empty `sha256`, no bytes are opened or hashed, `sources` stays
   * empty and no connector is read.
   */
  readonly sizesOnly?: boolean;
}
export {
  type RunFileGrant,
  type AgentRunResourceLoader,
  type AgentRunResourceSelection,
  type RunFileSource,
  type AgentRunResourceLoaderDependencies,
  type RunConnectionStore,
  type DeliveredStorageFolder,
  type ConnectorIdentityKey,
  type RunDirectoryGrant,
  type RunWritableConnectionStore,
  type RunStorageConnections,
  type PendingToolConnector,
  type ProjectResourceReader,
};
