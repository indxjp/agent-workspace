import { createHash } from 'node:crypto';
import type { RunSkillReference } from '@agent-workspace/run-protocol';
import { RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';
import { AGENT_MEMORY_DIRECTORY, agentMemoryFolder } from '@indx-workspace/contracts/agents';
import { narrowFileGrants, type StorageService } from '../storage-and-sharing';
import { listCatalogFiles } from '../storage/store';
import { DomainError } from '../errors';
import {
  type RunFileGrant,
  type AgentRunResourceLoader,
  type AgentRunResourceSelection,
  type RunFileSource,
  type AgentRunResourceLoaderDependencies,
} from './resource-loader-contract';

/** The sentence of a `run_files_too_large` refusal: the total and the limit. */
function runFilesTooLargeMessage(total: number): string {
  return (
    `the run's files total ${String(total)} bytes, over the limit of ` +
    `${String(RUN_FILES_MAX_BYTES)} bytes. Grant fewer or smaller files.`
  );
}

/** The run-start refusal of files over {@link RUN_FILES_MAX_BYTES} in total. */
function runFilesTooLarge(total: number): DomainError {
  return new DomainError({
    category: 'validation',
    code: 'run_files_too_large',
    publicMessage: `run_files_too_large: ${runFilesTooLargeMessage(total)}`,
  });
}

/** The bytes of every file reference and skill file a run is handed. */
function runFilesTotal(
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
function assertRunFilesFit(
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
function runInputFiles(
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
async function loadAttachedFiles(
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
function withAttachedFiles(
  granted: readonly RunFileGrant[],
  attached: readonly RunFileGrant[],
): RunFileGrant[] {
  const byPath = new Map(granted.map((file) => [file.path, file]));
  for (const file of attached) byPath.set(file.path, { ...file, access: 'read' });
  return [...byPath.values()];
}

/**
 * The size and checksum a reference carries: the row's own. A skill file read from a bare object
 * prefix has no row and so no checksum; its bytes are hashed in one streaming pass.
 */
async function referenceOf(
  row: { readonly sizeBytes: number; readonly sha256?: string | null },
  source: RunFileSource,
  what: string,
): Promise<{ readonly size: number; readonly sha256: string }> {
  if (row.sha256 !== undefined && row.sha256 !== null) {
    return { size: row.sizeBytes, sha256: row.sha256 };
  }
  // storage-bridge(#1699): a skill file of a bare object prefix has no recorded sha256
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

type CatalogFile = Awaited<ReturnType<typeof listCatalogFiles>>[number];
type FileAccess = 'read' | 'read-write';
interface SelectedFile {
  readonly kind: 'file' | 'directory';
  readonly access: FileAccess;
}
function selectCatalogPaths(
  byId: ReadonlyMap<string, CatalogFile>,
  grants: readonly { readonly fileId: string; readonly access: FileAccess }[],
): Map<string, SelectedFile> {
  const direct = new Map<string, SelectedFile>();
  const selected = new Map<string, SelectedFile>();

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
    if (row.kind === 'folder') selectCatalogChildren(byId, selected, row.path, grant.access);
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

  return selected;
}

function selectCatalogChildren(
  byId: ReadonlyMap<string, CatalogFile>,
  selected: Map<string, SelectedFile>,
  parentPath: string,
  access: FileAccess,
): void {
  // Only ready rows are listed, so a pending child never reaches the run.
  // @story US-STO-02
  // @story US-STO-05
  for (const child of byId.values()) {
    if (!child.path.startsWith(`${parentPath}/`)) continue;
    assertUserFilePath(child.path);
    if (!selected.has(child.path)) {
      selected.set(child.path, {
        kind: child.kind === 'folder' ? 'directory' : 'file',
        access: access,
      });
    }
  }
}

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
  const rows = await listCatalogFiles(catalog);
  // Skill files are rows of the same catalog; no grant, direct or by folder, ever reaches them.
  // @story US-STO-08
  const byId = new Map(
    rows.filter((file) => file.area !== 'skills').map((file) => [file.id, file]),
  );
  const rowsByPath = new Map(rows.map((file) => [file.path, file]));
  const selected = selectCatalogPaths(byId, grants);

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

/** One catalog page of a memory folder; a memory folder holds at most a few dozen files. */
const MEMORY_LIST_PAGE = 100;

/**
 * An agent's memory folder (ADR-0163): its ready files as read-write references at
 * `memory/<path>` under the run's working directory, after the directory itself, so an empty
 * folder is still a writable `memory/`. Only the `files` area is read, so a pending upload or a
 * skill never reaches it. The bytes are opened later, by the workspace lifecycle, through `sources`.
 */
async function loadMemoryFolder(
  workspaceId: string,
  agentId: string,
  dependencies: AgentRunResourceLoaderDependencies,
  sources: Map<string, RunFileSource>,
): Promise<readonly RunFileGrant[]> {
  const { storage } = dependencies;
  if (storage === undefined) {
    throw new Error('this agent keeps a memory folder, but file storage is not configured');
  }
  const folder = agentMemoryFolder(agentId);
  const out: RunFileGrant[] = [
    { kind: 'directory', path: AGENT_MEMORY_DIRECTORY, access: 'read-write' },
  ];
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<StorageService['list']>> = await storage.list(
      { workspaceId },
      'files',
      folder,
      cursor === null ? { limit: MEMORY_LIST_PAGE } : { cursor, limit: MEMORY_LIST_PAGE },
    );
    for (const row of page.rows) {
      if (!row.path.startsWith(`${folder}/`)) continue;
      const path = `${AGENT_MEMORY_DIRECTORY}/${row.path.slice(folder.length + 1)}`;
      if (dependencies.sizesOnly === true) {
        out.push({ kind: 'file', path, access: 'read-write', size: row.sizeBytes, sha256: '' });
        continue;
      }
      // Runs pass no actor: opening a run's input writes no audit row.
      const source: RunFileSource = {
        objectId: row.objectId ?? null,
        open: async () => (await storage.open({ workspaceId }, row))?.body ?? null,
      };
      const reference = await referenceOf(row, source, `memory file ${JSON.stringify(path)}`);
      sources.set(path, source);
      out.push({ kind: 'file', path, access: 'read-write', ...reference });
    }
    cursor = page.cursor;
  } while (cursor !== null);
  return out;
}
export {
  runFilesTooLarge,
  referenceOf,
  loadFiles,
  loadMemoryFolder,
  runFilesTooLargeMessage,
  runFilesTotal,
  assertRunFilesFit,
  runInputFiles,
  loadAttachedFiles,
  withAttachedFiles,
};
