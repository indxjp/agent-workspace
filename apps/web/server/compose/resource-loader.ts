import { createHash } from 'node:crypto';

import type {
  AgentPermissions,
  McpServerConfig,
  RunFileReference,
  RunSkillReference,
} from '@agent-workspace/run-protocol';
import { normalizeArchivePath, RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';

import type {
  AgentPermissionKey,
  AgentResourceAssignmentsInput,
} from '@indx-workspace/contracts/agents';
import { CONNECTOR_DISABLED_RUN_ERROR_CODE } from '@indx-workspace/contracts/connectors';
import {
  POSTGRES_TOOL_OPERATION_NAMES,
  connectorServerKey,
  toolApprovalRules,
  toolServerKeys,
  type ToolOperationMethod,
} from '@indx-workspace/contracts/tool-connectors';

import {
  isUnderAllowedPrefix,
  storageGrantListingUnavailable,
  storageGrantUnavailable,
} from '../agent-versions/storage-grants';
import { CONNECTOR_IDENTITY_UNSUPPORTED } from '../connectors/identity';
import type { ConnectorsStoreProvider } from '../connectors/store';
import { narrowFileGrants } from '../files/search-terms';
import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';
import { skillRevisionPrefix, skillRevisionRowFolder, skillRowFolder } from '../skills/keys';
import type { WorkspaceSkillsStoreProvider } from '../storage/store';
import { skillFiles } from '../skills/tree';
import type { StorageService } from '../storage/service';
import { DomainError } from '../errors';
import { STREAMED_SHA256 } from '../runs/streamed-digests';
import { log } from '../telemetry/logger';

/** A granted directory: created in the sandbox, with no bytes of its own. */
export interface RunDirectoryGrant {
  readonly kind: 'directory';
  readonly path: string;
  readonly access: 'read' | 'read-write';
}

/** What a run is told about one granted path: a file reference (no bytes) or a directory. */
export type RunFileGrant = RunFileReference | RunDirectoryGrant;

/**
 * Opens the bytes of one referenced file, lazily: nothing is read until `open` is called. It rides
 * beside the references and is never serialised into the `/run` body.
 */
export interface RunFileSource {
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
export interface RunConnectionStore {
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

/** The two calls a run's write-back makes of a connection's store; the object-store port satisfies it. */
export interface RunWritableConnectionStore {
  read(key: string): Promise<{
    readonly body: ReadableStream<Uint8Array>;
    readonly meta: { readonly etag: string };
  } | null>;
  write(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: { readonly ifNoneMatch: '*' } | { readonly ifMatch: string },
  ): Promise<unknown>;
}

/** The storage grant a folder was delivered writable for: the connection by id, never by name. */
export interface DeliveredStorageFolder {
  readonly connectionId: string;
  readonly prefix: string;
}

/** One storage connection of a workspace, as a run reads it (the storage design, §05). */
export interface RunStorageConnections {
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
  /** A store that can write: opened only by the write-back of a `read-write` grant. */
  openWritable(workspaceId: string, connectionId: string): Promise<RunWritableConnectionStore>;
}

/** Where the archive puts a granted skill's file, relative to the run's cwd; the runner reads it there. */
export function skillInboxPath(skill: string, file: string): string {
  return `.aw-inbox/skills/${skill}/${file}`;
}

/**
 * A tool connector of the run (ADR-0113 C16, C17), keyed by its SD13 server key. Compose turns it
 * into an `http` MCP server at the gateway once the run token exists.
 */
export interface PendingToolConnector {
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
export interface ConnectorIdentityKey {
  readonly connectorId: string;
  readonly key: string;
}

export interface AgentRunResourceSelection {
  readonly files: readonly RunFileGrant[];
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
export interface ProjectResourceReader {
  listFileIds(workspaceId: string, projectId: string): Promise<readonly string[]>;
  listMcpServerIds(workspaceId: string, projectId: string): Promise<readonly string[]>;
}

export interface AgentRunResourceLoader {
  /**
   * `assignments` are what the run's agent is assigned: its pinned version's, or the agent's own for
   * a legacy session (issue #612). `projectId`/`agentPermissions` are issue #125's addition and are optional so every pre-#125
   * call site (and this file's own pre-#125 tests) keeps compiling and behaving unchanged: no
   * project, no project resources. When a project is given, `agentPermissions` is the ceiling —
   * see {@link AgentRunResourceLoaderDependencies.projectResources}'s doc comment for what "no
   * permission" does. `ceilingCaps` are the switches the deployment's policy ceiling turned off
   * (S2-04c): a project resource refused for one of them is a typed `policy_cannot_widen` refusal
   * naming the ceiling, so the user sees why.
   */
  load(
    workspaceId: string,
    assignments: AgentResourceAssignmentsInput,
    projectId?: string | null,
    agentPermissions?: AgentPermissions,
    ceilingCaps?: readonly AgentPermissionKey[],
  ): Promise<AgentRunResourceSelection>;
}

export interface AgentRunResourceLoaderDependencies {
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

/** The sentence of a `run_files_too_large` refusal: the total and the limit. */
export function runFilesTooLargeMessage(total: number): string {
  return (
    `the run's files total ${String(total)} bytes, over the limit of ` +
    `${String(RUN_FILES_MAX_BYTES)} bytes. Grant fewer or smaller files.`
  );
}

/** The run-start refusal of files over {@link RUN_FILES_MAX_BYTES} in total. */
export function runFilesTooLarge(total: number): DomainError {
  return new DomainError({
    category: 'validation',
    code: 'run_files_too_large',
    publicMessage: `run_files_too_large: ${runFilesTooLargeMessage(total)}`,
  });
}

/** The bytes of every file reference and skill file a run is handed. */
export function runFilesTotal(
  files: readonly RunFileGrant[],
  skills: readonly RunSkillReference[],
): number {
  let total = 0;
  for (const file of files) if (file.kind === 'file') total += file.size;
  for (const skill of skills) for (const file of skill.files) total += file.size;
  return total;
}

/**
 * Refuse a run whose files, skill files and attachments total more than a run may be handed, before
 * anything is read or streamed (the storage design, §04).
 */
// @story US-STO-06
export function assertRunFilesFit(
  files: readonly RunFileGrant[],
  skills: readonly RunSkillReference[],
): void {
  const total = runFilesTotal(files, skills);
  if (total > RUN_FILES_MAX_BYTES) throw runFilesTooLarge(total);
}

/**
 * The files a run is handed: its grants narrowed to `fileScope` (issue #1539; a filter only, so it
 * never adds a file), then its attachments.
 */
export function runInputFiles(
  granted: readonly RunFileGrant[],
  attached: readonly RunFileGrant[],
  fileScope: readonly string[] | undefined,
): RunFileGrant[] {
  const scoped = fileScope === undefined ? granted : narrowFileGrants(granted, fileScope).kept;
  return withAttachedFiles(scoped, attached);
}

/**
 * The run's attachments as `read` grants (ADR-0146 Decision 2), loaded like any assigned file, so
 * each is a reference the runner checksums. No attachment (or no loader), no load.
 */
// @story US-STO-11
export async function loadAttachedFiles(
  loader: AgentRunResourceLoader | undefined,
  workspaceId: string,
  attachments: readonly { readonly fileId: string }[],
): Promise<Pick<AgentRunResourceSelection, 'files' | 'sources'>> {
  if (attachments.length === 0 || loader === undefined) return { files: [] };
  return loader.load(workspaceId, {
    files: attachments.map(({ fileId }) => ({ fileId, access: 'read' as const })),
    skillIds: [],
    connectorIds: [],
  });
}

/**
 * The granted files with the attached ones after them. An attachment is a `read` grant and the later
 * grant of a path wins, so a file both assigned and attached ends `read` (ADR-0146 Decision 2).
 */
export function withAttachedFiles(
  granted: readonly RunFileGrant[],
  attached: readonly RunFileGrant[],
): RunFileGrant[] {
  const byPath = new Map(granted.map((file) => [file.path, file]));
  for (const file of attached) byPath.set(file.path, { ...file, access: 'read' });
  return [...byPath.values()];
}

/**
 * The size and checksum a reference carries: the row's own. A row without a checksum is an object
 * in the old naming that the copy has not reached yet; its bytes are hashed in one streaming pass.
 */
async function referenceOf(
  row: { readonly sizeBytes: number; readonly sha256?: string | null },
  source: RunFileSource,
  what: string,
): Promise<{ readonly size: number; readonly sha256: string }> {
  if (row.sha256 !== undefined && row.sha256 !== null) {
    return { size: row.sizeBytes, sha256: row.sha256 };
  }
  // storage-bridge(#1699): an old-naming row has no sha256 until the copy records it
  const body = await source.open();
  if (body === null) throw new Error(`${what} has no stored bytes`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of body) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  return { size, sha256: hash.digest('hex') };
}

/**
 * The published reserved prefix of the workspace file tree, applied to what a run loads.
 *
 * The same rule `apps/web/server/files/handlers.ts` enforces at `PUT /api/files`, and spelled the
 * same way for the same reason (ADR-0072 D2): it is a statement about the tenant's file tree rather
 * than about one engine's sandbox. The *sandbox* half is the engine's own — the adapter refuses a
 * grant into its `protectedConfigDirectory` (`engine_policy_invalid`) and the runner refuses to
 * materialise one — so a file that reached here past this guard would still not be written.
 */
function assertUserFilePath(path: string): void {
  if (path.split('/', 1)[0]?.toLowerCase() === '.claude') {
    throw new Error(
      `assigned file ${JSON.stringify(path)} collides with the runner's private .claude directory`,
    );
  }
}

/**
 * Each granted path as a reference: path, access, size and checksum, never bytes (the storage
 * design, §04). A folder grant reaches the ready catalog rows under it, never a store listing, so a
 * pending upload or a staged object never reaches a run, and neither does an object without a row
 * (the default adopt stage gives every old-naming object one). The bytes are opened later, by the
 * workspace lifecycle, through `sources`.
 */
// @story US-STO-06
async function loadFiles(
  workspaceId: string,
  grants: readonly { readonly fileId: string; readonly access: 'read' | 'read-write' }[],
  dependencies: AgentRunResourceLoaderDependencies,
  sources: Map<string, RunFileSource>,
): Promise<readonly RunFileGrant[]> {
  if (grants.length === 0) return [];
  const { storage } = dependencies;
  if (storage === undefined) {
    throw new Error('this agent has assigned files, but file storage is not configured');
  }

  const catalog = await dependencies.catalog.forWorkspace(workspaceId);
  const rows = await catalog.listFiles();
  // Skill files are rows of the same catalog; no grant, direct or by folder, ever reaches them.
  // @story US-STO-08
  const byId = new Map(
    rows.filter((file) => file.area !== 'skills').map((file) => [file.id, file]),
  );
  const rowsByPath = new Map(rows.map((file) => [file.path, file]));
  const direct = new Map<
    string,
    { readonly kind: 'file' | 'directory'; readonly access: 'read' | 'read-write' }
  >();
  const selected = new Map<string, { kind: 'file' | 'directory'; access: 'read' | 'read-write' }>();

  for (const grant of grants) {
    const row = byId.get(grant.fileId);
    if (row === undefined) {
      throw new Error(`assigned file ${grant.fileId} disappeared before the run was composed`);
    }
    assertUserFilePath(row.path);
    direct.set(row.path, {
      kind: row.kind === 'folder' ? 'directory' : 'file',
      access: grant.access,
    });
    selected.set(row.path, {
      kind: row.kind === 'folder' ? 'directory' : 'file',
      access: grant.access,
    });
    if (row.kind === 'folder') {
      // Only ready rows are listed, so a pending child never reaches the run.
      // @story US-STO-02
      // @story US-STO-05
      for (const child of byId.values()) {
        if (!child.path.startsWith(`${row.path}/`)) continue;
        assertUserFilePath(child.path);
        if (!selected.has(child.path)) {
          selected.set(child.path, {
            kind: child.kind === 'folder' ? 'directory' : 'file',
            access: grant.access,
          });
        }
      }
    }
  }

  // Explicit grants are applied broadest-to-narrowest. A child directory grant governs its whole
  // subtree, while an even more specific descendant grant can still override it afterward.
  const explicit = [...direct].sort(
    ([left], [right]) => left.split('/').length - right.split('/').length,
  );
  for (const [path, grant] of explicit) {
    for (const [selectedPath, item] of selected) {
      if (
        selectedPath === path ||
        (grant.kind === 'directory' && selectedPath.startsWith(`${path}/`))
      ) {
        selected.set(selectedPath, { ...item, access: grant.access });
      }
    }
  }

  const out: RunFileGrant[] = [];
  for (const [path, selectedFile] of [...selected].sort(([a], [b]) => a.localeCompare(b))) {
    if (selectedFile.kind === 'directory') {
      out.push({ kind: 'directory', path, access: selectedFile.access });
      continue;
    }
    const row = rowsByPath.get(path);
    if (row === undefined) throw new Error(`assigned file ${JSON.stringify(path)} has no row`);
    if (dependencies.sizesOnly === true) {
      out.push({
        kind: 'file',
        path,
        access: selectedFile.access,
        size: row.sizeBytes,
        sha256: '',
      });
      continue;
    }
    // Runs and system callers pass no actor: opening a run's input writes no audit row.
    // @story US-STO-05
    const source: RunFileSource = {
      objectId: row.objectId ?? null,
      open: async () => (await storage.open({ workspaceId }, row))?.body ?? null,
    };
    const reference = await referenceOf(row, source, `assigned file ${JSON.stringify(path)}`);
    sources.set(path, source);
    out.push({ kind: 'file', path, access: selectedFile.access, ...reference });
  }
  return out;
}

/**
 * A key is deliverable only if it is already the path it would be archived as: `normalizeArchivePath`
 * decodes and folds, so any key it changes (`..`, `%2e%2e`, `\\`, an absolute path, a trailing `/`) is skipped.
 */
function isArchivableKey(key: string): boolean {
  try {
    return normalizeArchivePath(key) === key;
  } catch {
    return false;
  }
}

/** One page of a granted folder; a provider failure is the run's typed refusal. */
async function listGrantedFolder(
  store: RunConnectionStore,
  prefix: string,
  options: { readonly recursive: true; readonly cursor?: string },
  connectionName: string,
): ReturnType<RunConnectionStore['listPage']> {
  try {
    return await store.listPage(prefix, options);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw storageGrantListingUnavailable(connectionName, error);
  }
}

/**
 * Each granted connection folder as references under `storage/<name>/` (the storage design, §05).
 * The grant is judged against the connection as it is now, not as it was deployed: a connection that
 * is gone or no longer allows the folder refuses the run. The folder is delivered writable only to a
 * `read-write` grant of a connection that allows writes, and `storage-writeback.ts` saves the run's
 * changes. It is listed page by page; the bytes are streamed later through `sources`.
 */
// @story US-STO-12
async function loadStorageGrants(
  workspaceId: string,
  grants: NonNullable<AgentResourceAssignmentsInput['storageGrants']>,
  dependencies: AgentRunResourceLoaderDependencies,
  sources: Map<string, RunFileSource>,
  mayWrite: boolean,
  folders: Map<string, DeliveredStorageFolder>,
): Promise<readonly RunFileGrant[]> {
  if (grants.length === 0) return [];
  const { storageConnections } = dependencies;
  if (storageConnections === undefined) {
    throw storageGrantUnavailable('this deployment keeps no storage connections');
  }
  const sizesOnly = dependencies.sizesOnly === true;
  const byPath = new Map<string, RunFileGrant>();
  const add = (grant: RunFileGrant): void => {
    const held = byPath.get(grant.path);
    byPath.set(grant.path, held?.access === 'read' ? held : grant);
  };
  let total = 0;
  for (const grant of grants) {
    const connection = await storageConnections.get(workspaceId, grant.connectionId);
    if (connection === null) {
      throw storageGrantUnavailable('a granted storage connection no longer exists');
    }
    if (
      !connection.allowedPrefixes.some((allowed) => isUnderAllowedPrefix(grant.prefix, allowed))
    ) {
      throw storageGrantUnavailable(
        `the folder ${JSON.stringify(grant.prefix)} is no longer one the connection ${JSON.stringify(connection.name)} allows`,
      );
    }
    // Writable only when the grant, the agent's `writeFiles` and the connection all allow it.
    const access =
      grant.access === 'read-write' && mayWrite && connection.writeAllowed ? 'read-write' : 'read';
    const root = `storage/${connection.name}`;
    const store = await storageConnections.open(workspaceId, grant.connectionId);
    add({ kind: 'directory', path: `${root}/${grant.prefix}`, access });
    if (access === 'read-write') {
      folders.set(`${root}/${grant.prefix}`, {
        connectionId: grant.connectionId,
        prefix: grant.prefix,
      });
    }
    let skipped = 0;
    let cursor: string | undefined;
    do {
      const page = await listGrantedFolder(
        store,
        grant.prefix,
        cursor === undefined ? { recursive: true } : { recursive: true, cursor },
        connection.name,
      );
      for (const entry of page.entries) {
        if (entry.kind !== 'file') continue;
        const { key } = entry;
        const path = `${root}/${key}`;
        if (
          !key.startsWith(`${grant.prefix}/`) ||
          !isArchivableKey(key) ||
          !isArchivableKey(path)
        ) {
          skipped += 1;
          continue;
        }
        // Overlapping grants list the same object twice; it is delivered, and counted, once.
        if (!byPath.has(path)) total += entry.sizeBytes;
        if (total > RUN_FILES_MAX_BYTES) throw runFilesTooLarge(total);
        add({
          kind: 'file',
          path,
          access,
          size: entry.sizeBytes,
          sha256: sizesOnly ? '' : STREAMED_SHA256,
        });
        if (!sizesOnly) {
          sources.set(path, {
            objectId: null,
            streamed: true,
            open: async () => (await store.read(key))?.body ?? null,
          });
        }
      }
      cursor = page.cursor ?? undefined;
    } while (cursor !== undefined);
    if (skipped > 0) {
      log.warn('[runs] storage objects with unsafe keys were not delivered', {
        connectionId: grant.connectionId,
        skipped,
      });
    }
  }
  return [...byPath.values()];
}

/** Each file of each enabled skill as a reference (path, size, checksum); its bytes go to `sources`. */
async function loadSkills(
  workspaceId: string,
  skillIds: readonly string[],
  skillRevisions: Readonly<Record<string, number>>,
  dependencies: AgentRunResourceLoaderDependencies,
  sources: Map<string, RunFileSource>,
): Promise<readonly RunSkillReference[]> {
  if (skillIds.length === 0) return [];
  if (dependencies.skills === undefined) {
    throw new Error('this agent has assigned skills, but skill storage is not configured');
  }

  const catalog = await dependencies.catalog.forWorkspace(workspaceId);
  const byId = new Map((await catalog.listSkills()).map((skill) => [skill.id, skill]));
  const store = dependencies.skills.forWorkspace(workspaceId);
  const rows =
    dependencies.storage === undefined ? undefined : { storage: dependencies.storage, workspaceId };
  const out: RunSkillReference[] = [];
  for (const skillId of skillIds) {
    const skill = byId.get(skillId);
    if (skill === undefined) {
      throw new Error(`assigned skill ${skillId} disappeared before the run was composed`);
    }
    if (!skill.enabled) continue;
    // A pinned skill is the frozen revision (SDK-19, N-1); an unpinned one follows its current content.
    const pinned = skillRevisions[skillId];
    // @story US-STO-08
    const listed =
      pinned === undefined
        ? await skillFiles(store, rows, skillRowFolder(skill.name), `skills/${skill.name}`)
        : await skillFiles(
            store,
            rows,
            skillRevisionRowFolder(skill.name, pinned),
            skillRevisionPrefix(skill.name, pinned),
          );
    if (!listed.some((entry) => entry.relativePath === 'SKILL.md')) {
      throw new Error(`assigned skill ${JSON.stringify(skill.name)} has no SKILL.md`);
    }
    const files: { path: string; size: number; sha256: string }[] = [];
    for (const entry of listed) {
      if (dependencies.sizesOnly === true) {
        files.push({ path: entry.relativePath, size: entry.sizeBytes, sha256: '' });
        continue;
      }
      const source: RunFileSource = { objectId: null, open: () => entry.open() };
      const reference = await referenceOf(
        { sizeBytes: entry.sizeBytes, sha256: entry.sha256 },
        source,
        `assigned skill file ${JSON.stringify(entry.relativePath)}`,
      );
      sources.set(skillInboxPath(skill.name, entry.relativePath), source);
      files.push({ path: entry.relativePath, ...reference });
    }
    out.push({ name: skill.name, files });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

type LoadedConnectors = Pick<
  AgentRunResourceSelection,
  'mcpServers' | 'connectorNames' | 'connectorKeys' | 'connectorIdentities' | 'toolConnectors'
>;

async function loadConnectors(
  workspaceId: string,
  connectorIds: readonly string[],
  projectConnectorIds: ReadonlySet<string>,
  dependencies: AgentRunResourceLoaderDependencies,
): Promise<LoadedConnectors> {
  if (connectorIds.length === 0) return { mcpServers: {} };
  if (dependencies.connectors === undefined) {
    throw new Error('this agent has assigned connectors, but connector storage is not configured');
  }

  const store = dependencies.connectors.forWorkspace(workspaceId);
  const mcps: {
    readonly id: string;
    readonly name: string;
    readonly config: McpServerConfig;
    readonly identityKey?: string;
  }[] = [];
  const tools: {
    connectorId: string;
    name: string;
    operationNames: readonly string[];
    operations: readonly { readonly name: string; readonly method: ToolOperationMethod }[];
    identity?: true;
  }[] = [];
  for (const connectorId of connectorIds) {
    const [connector, probe] = await Promise.all([
      store.get(connectorId),
      store.resolveForProbe(connectorId),
    ]);
    if (connector === null) {
      throw new Error(`assigned connector ${connectorId} disappeared before the run was composed`);
    }
    // A disabled connector is refused, not dropped: a run that silently lost a tool its agent was
    // configured with would fail later and further from the cause (#240). The same holds for one a
    // project association brings in (issue #125), so the message names both sources.
    if (!connector.enabled) {
      throw new DomainError({
        category: 'conflict',
        code: CONNECTOR_DISABLED_RUN_ERROR_CODE,
        publicMessage:
          `${CONNECTOR_DISABLED_RUN_ERROR_CODE}: connector ${connector.id} is disabled; ` +
          'enable it, or remove it from the agent or the project that brings it into this run',
      });
    }
    // ADR-0142 D1: an opted-in connector whose secret cannot be read fails the run here, so it is
    // never dialled without the identity it asked for.
    const identityKey =
      connector.identity === undefined ? undefined : await store.resolveIdentityKey(connector.id);
    if (identityKey === null) {
      throw new DomainError({
        category: 'validation',
        code: CONNECTOR_IDENTITY_UNSUPPORTED,
        publicMessage:
          `${CONNECTOR_IDENTITY_UNSUPPORTED}: connector ${connector.id} names an identity secret ` +
          'this workspace cannot resolve; create the secret, or remove "identity" from the connector',
      });
    }
    if (connector.kind === 'openapi' || connector.kind === 'postgres') {
      // #586: a project binds MCP connectors only, and its write path refuses a tool connector; a
      // binding written before that refusal is refused here rather than handed to the engine.
      if (projectConnectorIds.has(connector.id)) {
        throw new DomainError({
          category: 'validation',
          code: 'project_connector_not_mcp',
          publicMessage:
            `project_connector_not_mcp: connector ${connector.id} is a ${connector.kind} tool ` +
            'connector; remove it from the project and assign it to the agent instead',
        });
      }
      const needsCredential =
        connector.kind === 'postgres' || (connector.openapi?.auth ?? 'none') !== 'none';
      if (needsCredential && !connector.hasCredential) {
        throw new Error(
          `assigned connector ${JSON.stringify(connector.name)} has no resolvable credential`,
        );
      }
      const operations = connector.kind === 'postgres' ? [] : (connector.openapi?.operations ?? []);
      tools.push({
        connectorId: connector.id,
        name: connector.name,
        operationNames:
          connector.kind === 'postgres'
            ? [...POSTGRES_TOOL_OPERATION_NAMES]
            : operations.map((operation) => operation.name),
        operations,
        ...(identityKey === undefined ? {} : { identity: true as const }),
      });
      continue;
    }
    if (probe === null) {
      throw new Error(`assigned connector ${JSON.stringify(connector.name)} could not be resolved`);
    }
    if (connector.authType !== 'none' && !probe.credentialConfigured) {
      throw new Error(
        `assigned connector ${JSON.stringify(connector.name)} has no resolvable credential`,
      );
    }
    mcps.push({
      id: connector.id,
      name: connector.name,
      ...(identityKey === undefined ? {} : { identityKey }),
      config:
        probe.transport === 'stdio'
          ? {
              type: 'stdio',
              command: probe.command,
              args: [...probe.args],
              ...(Object.keys(probe.env).length === 0 ? {} : { env: { ...probe.env } }),
            }
          : {
              type: probe.transport,
              url: probe.url,
              ...(Object.keys(probe.headers).length === 0 ? {} : { headers: { ...probe.headers } }),
            },
    });
  }
  // SD13 orders a run's colliding names by connector id.
  tools.sort((a, b) => (a.connectorId < b.connectorId ? -1 : 1));
  const keys = toolServerKeys(tools.map((tool) => tool.name));
  // Tool keys are fixed first; an MCP connector whose name spells one falls back to its id (#1109).
  const taken = new Set(keys);
  const configs: Record<string, McpServerConfig> = {};
  const names: Record<string, string> = {};
  const connectorKeys: Record<string, string> = {};
  const identities: Record<string, ConnectorIdentityKey> = {};
  for (const mcp of mcps) {
    const key = connectorServerKey(mcp.name, mcp.id, taken);
    configs[key] = mcp.config;
    names[key] = mcp.name;
    connectorKeys[mcp.id] = key;
    if (mcp.identityKey !== undefined) {
      identities[key] = { connectorId: mcp.id, key: mcp.identityKey };
    }
  }
  const connectorIdentities =
    Object.keys(identities).length === 0 ? {} : { connectorIdentities: identities };
  if (tools.length === 0) {
    return { mcpServers: configs, connectorNames: names, connectorKeys, ...connectorIdentities };
  }
  return {
    mcpServers: configs,
    connectorNames: names,
    connectorKeys,
    ...connectorIdentities,
    toolConnectors: tools.map((tool, index) => {
      const key = keys[index];
      if (key === undefined) throw new Error('toolServerKeys returned fewer keys than names');
      const approvalRules = toolApprovalRules(key, tool.operations);
      return {
        key,
        connectorId: tool.connectorId,
        name: tool.name,
        operationNames: tool.operationNames,
        ...(approvalRules.length === 0 ? {} : { approvalRules }),
        ...(tool.identity === undefined ? {} : { identity: true as const }),
      };
    }),
  };
}

/**
 * The project's read-only file grants, or the pre-launch refusal for #125's narrowing rule.
 *
 * `project_files` is a bare id list (ADR: `W9-PLAN-project-file-grants-are-read-only-in-wave-9`),
 * so every id it names becomes a `'read'` grant — never `'read-write'`, structurally, because
 * nothing here ever produces that value for a project-sourced id. Grants are returned **ahead of**
 * the agent's own in the array `loadFiles` merges: that function already applies the shallowest
 * grant first and lets a deeper, more specific grant repaint its own subtree (see its own tests),
 * so putting the project's grants first and the agent's own after — unchanged — makes the agent's
 * own explicit assignment win whenever it names the same id or a deeper path, and lets the
 * project's grant win a subtree the agent only reaches through a shallower grant of its own. That
 * is #125's "agent wins for the same file id, the more restrictive mode wins for the same path"
 * in one existing algorithm, not a second one.
 *
 * The ceiling is `agentPermissions.readFiles`: a project cannot hand an agent file access its own
 * tool permissions do not include, so any project file association is refused outright (not
 * silently dropped — see the loader's own doc comment) when that permission is off.
 */
async function loadProjectFileGrants(
  workspaceId: string,
  projectId: string,
  agentPermissions: AgentPermissions | undefined,
  ceilingCaps: readonly AgentPermissionKey[],
  dependencies: AgentRunResourceLoaderDependencies,
): Promise<readonly { readonly fileId: string; readonly access: 'read' }[]> {
  if (dependencies.projectResources === undefined) return [];
  const fileIds = await dependencies.projectResources.listFileIds(workspaceId, projectId);
  if (fileIds.length === 0) return [];
  if (agentPermissions?.readFiles !== true) {
    if (ceilingCaps.includes('readFiles')) {
      throw ceilingCappedProjectResource(
        projectId,
        `${String(fileIds.length)} file(s)/folder(s)`,
        'readFiles',
      );
    }
    throw new Error(
      `project ${projectId} associates ${String(fileIds.length)} file(s)/folder(s), but the ` +
        'agent running this session does not have the readFiles tool permission — a project ' +
        "association can only narrow an agent's own permissions, never widen them.",
    );
  }
  return fileIds.map((fileId) => ({ fileId, access: 'read' as const }));
}

/** The refusal of a project resource whose switch the deployment's policy ceiling turned off. */
function ceilingCappedProjectResource(
  projectId: string,
  associates: string,
  key: AgentPermissionKey,
): DomainError {
  return new DomainError({
    category: 'validation',
    code: 'policy_cannot_widen',
    publicMessage:
      `policy_cannot_widen: project ${projectId} associates ${associates}, but this deployment's ` +
      `policy ceiling caps permissions.${key}. Remove the association from the project, or ask ` +
      'an administrator to raise the ceiling.',
  });
}

/**
 * The project's connector ids, or the pre-launch refusal for #125's narrowing rule.
 *
 * The ceiling is `agentPermissions.unrestrictedNetwork` — an MCP connector is a network egress,
 * and #125 asks that "a project connector whose credential the agent is not authorised for is
 * dropped and reported as a pre-launch error"; this codebase has no per-agent, per-connector
 * authorisation narrower than that tool permission, so that is the check. Whether the resulting
 * connector is actually usable (enabled, has a resolvable credential) is `loadConnectors`'s own,
 * unchanged, check — applied identically to a project-sourced id and an agent-assigned one.
 */
async function loadProjectConnectorIds(
  workspaceId: string,
  projectId: string,
  agentPermissions: AgentPermissions | undefined,
  ceilingCaps: readonly AgentPermissionKey[],
  dependencies: AgentRunResourceLoaderDependencies,
): Promise<readonly string[]> {
  if (dependencies.projectResources === undefined) return [];
  const connectorIds = await dependencies.projectResources.listMcpServerIds(workspaceId, projectId);
  if (connectorIds.length === 0) return [];
  if (agentPermissions?.unrestrictedNetwork !== true) {
    if (ceilingCaps.includes('unrestrictedNetwork')) {
      throw ceilingCappedProjectResource(
        projectId,
        `${String(connectorIds.length)} connector(s)`,
        'unrestrictedNetwork',
      );
    }
    throw new Error(
      `project ${projectId} associates ${String(connectorIds.length)} connector(s), but the ` +
        'agent running this session does not have the unrestrictedNetwork tool permission, so ' +
        "it is not authorised for those connectors' credentials.",
    );
  }
  return connectorIds;
}

export function createAgentRunResourceLoader(
  dependencies: AgentRunResourceLoaderDependencies,
): AgentRunResourceLoader {
  return {
    async load(
      workspaceId,
      assignments,
      projectId = null,
      agentPermissions = undefined,
      ceilingCaps = [],
    ) {
      const [projectFileGrants, projectConnectorIds] =
        projectId === null || projectId === undefined
          ? [[], []]
          : await Promise.all([
              loadProjectFileGrants(
                workspaceId,
                projectId,
                agentPermissions,
                ceilingCaps,
                dependencies,
              ),
              loadProjectConnectorIds(
                workspaceId,
                projectId,
                agentPermissions,
                ceilingCaps,
                dependencies,
              ),
            ]);
      // A connector the agent is assigned is the agent's own, even when the project names it too.
      const agentConnectorIds = new Set(assignments.connectorIds);
      const sources = new Map<string, RunFileSource>();
      // A storage reference wins over a workspace file at the same path, so its source must too:
      // the loaders run concurrently, and a shared map would keep whichever wrote last.
      const storedSources = new Map<string, RunFileSource>();
      const storageFolders = new Map<string, DeliveredStorageFolder>();
      // ponytail: three listings per run (preflight, compose, archive); pass one load through the launch if bucket latency or list cost matters
      const [files, stored, skills, connectors] = await Promise.all([
        loadFiles(workspaceId, [...projectFileGrants, ...assignments.files], dependencies, sources),
        loadStorageGrants(
          workspaceId,
          assignments.storageGrants ?? [],
          dependencies,
          storedSources,
          agentPermissions?.writeFiles === true,
          storageFolders,
        ),
        loadSkills(
          workspaceId,
          assignments.skillIds,
          assignments.skillRevisions ?? {},
          dependencies,
          sources,
        ),
        dependencies.sizesOnly === true
          ? { mcpServers: {} }
          : loadConnectors(
              workspaceId,
              [...new Set([...projectConnectorIds, ...assignments.connectorIds])],
              new Set(projectConnectorIds.filter((id) => !agentConnectorIds.has(id))),
              dependencies,
            ),
      ]);
      return {
        files: [...new Map([...files, ...stored].map((file) => [file.path, file])).values()],
        skills,
        sources: new Map([...sources, ...storedSources]),
        ...(storageFolders.size === 0 ? {} : { storageFolders }),
        ...connectors,
      };
    },
  };
}
