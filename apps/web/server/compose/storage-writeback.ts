/**
 * Write a completed run's new and changed files under a `read-write` storage grant back to the
 * customer's connection (the storage design, §05: "Writing needs a separate, explicit grant").
 * Nothing is ever deleted, nothing is written outside the granted prefix, and every gate is read
 * again here rather than trusted from launch. A file is written only when both the launch body and
 * the gates as they are now allow it, so a restriction lifted during the run never widens it. It
 * never throws: a failure here must not fail a run that already completed.
 */
// @story US-STO-12
import { createHash } from 'node:crypto';

import { toObjectKey } from '@agent-workspace/core/storage/keys';
import {
  readUstarStream,
  RUN_FILES_MAX_BYTES,
  RUN_FILES_MAX_MEMBERS,
} from '@agent-workspace/runtime/transfer';
import { RUN_FILE_CORRUPT } from '@indx-workspace/contracts/runs';
import { z } from 'zod';

import { isUnderAllowedPrefix } from '../agent-versions/storage-grants';
import type { RunAgent } from '../agent-versions/session-version';
import type { StorageGrantRef } from '../agent-versions/store';
import { DomainError } from '../errors';
import type { LaunchContext } from '../runs/environment';
import { ObjectConflictError } from '../storage/objects';
import { log } from '../telemetry/logger';
import type {
  DeliveredStorageFolder,
  RunStorageConnections,
  RunWritableConnectionStore,
} from './resource-loader';
import { verified } from './workspace-lifecycle';

/** The one audit row a run leaves per connection it wrote, refused or conflicted on. */
export interface StorageWriteBackAuditEvent {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly actorUserId: string | null;
  readonly actorLabel: string;
  readonly action: 'storage-connection-written';
  readonly subjectId: string;
  readonly subjectLabel: string;
}

export interface StorageWriteBackDeps {
  /** The run's agent as it is now, uncached: a version or grant row that is gone throws. */
  readonly readRunAgent: (
    workspaceId: string,
    agentId: string,
    agentVersionId: string | null,
  ) => Promise<RunAgent>;
  readonly connections: Pick<RunStorageConnections, 'get' | 'openWritable'>;
  /** Bounded by {@link STORAGE_WRITEBACK_AUDIT_DEADLINE_MS}: a hung audit store never holds the session. */
  readonly audit: (event: StorageWriteBackAuditEvent) => Promise<void>;
  /**
   * Whether the stored run is still `running`, asked before the first file is written and then at
   * most once per {@link STORAGE_WRITEBACK_STATUS_INTERVAL_MS}, so a cancel stored by another
   * replica stops the save within that interval rather than at the deadline.
   */
  readonly stillRunning: (runId: string) => Promise<boolean>;
}

/** How long the write-back waits for its audit row to be recorded, after its own deadline. */
export const STORAGE_WRITEBACK_AUDIT_DEADLINE_MS = 10_000;

/** The least time between two stored-status reads: a save of many files is not one read per file. */
export const STORAGE_WRITEBACK_STATUS_INTERVAL_MS = 1_000;

export interface StorageWriteBackRun {
  readonly context: LaunchContext;
  /** The `/run` body the runtime was sent: the composed permissions and the delivered entries. */
  readonly body: unknown;
  /** The run's directory relative to the runtime root; archive members start with it. */
  readonly cwd: string;
  /** The tar of one runtime-root-relative path, streamed; `null` when the agent left nothing there. */
  readonly collect: (path: string) => Promise<ReadableStream<Uint8Array> | null>;
  /**
   * The grant behind each folder the loader delivered writable, by its path under the run's cwd:
   * the connection written is the one that was delivered, whatever it is called now.
   */
  readonly folders: ReadonlyMap<string, DeliveredStorageFolder>;
  /**
   * The grant behind each folder the input archive was loaded with, by the same paths; absent when
   * the launch hydrated no archive. The archive and the `/run` body are two loads, and a connection
   * renamed between them can put one connection's files under the name the body gives another: a
   * folder the two loads did not deliver for the same grant is refused rather than written.
   */
  readonly hydrated?: ReadonlyMap<string, DeliveredStorageFolder>;
  /**
   * The write-back's deadline, or an interrupt: it stops between files, and the rest count as
   * failed. A deadline aborts with a `TimeoutError`, as `AbortSignal.timeout` does; any other
   * reason is an interrupt.
   */
  readonly signal: AbortSignal;
}

export interface WriteBackCounts {
  written: number;
  unchanged: number;
  conflicted: number;
  refused: number;
  failed: number;
  bytes: number;
}

/** Why a grant wrote nothing; the audit row names it, and nothing the agent or a customer chose. */
export type WriteBackRefusal =
  | 'run_cannot_write'
  | 'grant_missing'
  | 'agent_cannot_write'
  | 'connection_missing'
  | 'connection_unavailable'
  | 'write_not_allowed'
  | 'prefix_not_allowed'
  | 'archive_refused'
  | 'folder_mismatch'
  | 'deadline'
  | 'interrupted';

const RunBodySchema = z.object({
  portable: z.object({ permissions: z.object({ writeFiles: z.boolean() }) }),
  resources: z.object({
    files: z.array(
      z.object({
        kind: z.string().optional(),
        path: z.string(),
        access: z.string().optional(),
        sha256: z.string().optional(),
      }),
    ),
  }),
});

type BodyFiles = z.infer<typeof RunBodySchema>['resources']['files'];

interface Planned {
  readonly size: number;
  readonly sha256: string;
  /** The checksum the file was delivered with; `undefined` for a file the agent created. */
  readonly delivered: string | undefined;
}

/** A path the launch body delivered read-only: one file, or a folder and everything under it. */
interface LaunchReadOnly {
  readonly path: string;
  readonly recursive: boolean;
}

/** A folder the body delivered `read-write`, with the grant the loader delivered it for. */
interface DeliveredFolder extends DeliveredStorageFolder {
  /** The folder under the run's cwd, as it was delivered: `storage/<name>/<prefix>`. */
  readonly path: string;
  /** Whether the input archive was loaded with this folder for the same grant. */
  readonly hydratedSame: boolean;
}

interface Folder {
  readonly runId: string;
  readonly connectionId: string;
  readonly prefix: string;
  /** The folder under the run's cwd, as it was delivered. */
  readonly delivered: string;
  /** The same folder under the runtime root, which is what the archive members are named by. */
  readonly path: string;
  /** The connection key a member of the folder is saved at; `null` for one that must not be. */
  readonly keyOf: (memberPath: string) => string | null;
  readonly signal: AbortSignal;
  /** Asks whether the stored run is still running; when it is not, stops the save. */
  readonly stillRunning: () => Promise<boolean>;
}

interface FolderPlan {
  readonly changed: Map<string, Planned>;
  readonly unchanged: number;
  readonly refused: number;
  readonly archiveBytes: number;
}

/** What every folder of one run's write-back shares. */
interface WriteBackScope {
  readonly run: StorageWriteBackRun;
  /** The run's signal, or a cancel the stored status showed: everything here stops on it. */
  readonly signal: AbortSignal;
  /** Stops the write-back once the stored run is no longer running. */
  readonly stop: () => void;
  readonly deps: StorageWriteBackDeps;
  readonly runWrites: boolean;
  /** The run's agent as it is now; `null` when its version or grant rows are gone. */
  readonly fresh: RunAgent | null;
  /** The checksum each file was delivered with, by its path under the run's cwd. */
  readonly delivered: ReadonlyMap<string, string>;
  /** What the launch body delivered read-only, by path under the run's cwd. */
  readonly launchReadOnly: readonly LaunchReadOnly[];
  readonly handled: Set<string>;
  budget: number;
  /** When the stored status was last read (`Date.now()`), or `null` before the first read. */
  statusReadAt: number | null;
}

const newCounts = (): WriteBackCounts => ({
  written: 0,
  unchanged: 0,
  conflicted: 0,
  refused: 0,
  failed: 0,
  bytes: 0,
});

/** `work`, or a rejection with the signal's reason once it aborts, whichever comes first. */
function unlessAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('the write-back stopped'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/** Why `signal` stopped the write-back: its deadline, or an interrupt (here or on another replica). */
const stopReason = (signal: AbortSignal): WriteBackRefusal =>
  signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
    ? 'deadline'
    : 'interrupted';

/** `work`, or a rejection once `ms` pass; the timer is cleared when `work` settles first. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the write-back audit did not answer in time'));
    }, ms);
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
    });
  });
}

/** `source`, erroring once `signal` aborts, so a stalled read cannot outlast the deadline. */
function untilAborted(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await unlessAborted(reader.read(), signal);
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (cause) {
          await reader.cancel().catch(() => undefined);
          throw cause;
        }
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
}

async function sha256Of(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of chunks) hash.update(chunk);
  return hash.digest('hex');
}

function streamOf(chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await iterator.next();
        if (next.done === true) controller.close();
        else controller.enqueue(next.value);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * The connection key of archive member `memberPath` under `<cwd>/storage/<name>/<prefix>/`, or
 * `null` for a member that is not a descendant of the folder or whose key the object-store guard
 * would refuse or change (an empty, `.` or `..` segment, a backslash, a control character, `%`).
 * The key is the grant's prefix plus the member's path, so it is always inside the grant, and
 * inside the connection's allowed prefixes whenever the grant's prefix is.
 */
function connectionKey(memberPath: string, folder: string, prefix: string): string | null {
  if (!memberPath.startsWith(`${folder}/`)) return null;
  const key = `${prefix}/${memberPath.slice(folder.length + 1)}`;
  try {
    return toObjectKey(key) === key ? key : null;
  } catch {
    return null;
  }
}

/** The path under the run's cwd that connection key `key` of a folder was delivered at. */
const deliveredPath = (delivered: string, prefix: string, key: string): string =>
  `${delivered}${key.slice(prefix.length)}`;

/**
 * Every entry of the launch body that is not `read-write`; an entry without an access is read-only.
 * Only an entry that is certainly a file is exact: one without a kind, or of an unknown kind,
 * protects everything under it too.
 */
function launchReadOnlyPaths(files: BodyFiles): readonly LaunchReadOnly[] {
  return files.flatMap((file) =>
    file.access === 'read-write' ? [] : [{ path: file.path, recursive: file.kind !== 'file' }],
  );
}

const isReadOnlyAtLaunch = (path: string, readOnly: readonly LaunchReadOnly[]): boolean =>
  readOnly.some(
    (entry) => path === entry.path || (entry.recursive && path.startsWith(`${entry.path}/`)),
  );

/**
 * Keys of the folder that may be saved: safe keys of the grant that neither a read-only grant as it
 * is now nor a read-only path of the launch body covers. Requiring both means a read-only grant
 * removed during the run cannot open its files to an overlapping `read-write` grant, and one added
 * during the run still closes them.
 */
function keyResolver(
  grant: StorageGrantRef,
  scope: WriteBackScope,
  target: DeliveredFolder,
  path: string,
): Folder['keyOf'] {
  // Overlapping grants deliver the shared files read-only, so a read folder's files are not this grant's.
  const readOnly = (scope.fresh?.assignments.storageGrants ?? [])
    .filter((other) => other.access === 'read' && other.connectionId === grant.connectionId)
    .map((other) => other.prefix);
  return (memberPath) => {
    const key = connectionKey(memberPath, path, grant.prefix);
    if (key === null || readOnly.some((prefix) => isUnderAllowedPrefix(key, prefix))) return null;
    const launched = deliveredPath(target.path, target.prefix, key);
    return isReadOnlyAtLaunch(launched, scope.launchReadOnly) ? null : key;
  };
}

/** Pass 1 reads the whole folder and writes nothing; an archive problem throws and refuses the grant. */
async function planFolder(
  archive: ReadableStream<Uint8Array>,
  folder: Folder,
  scope: WriteBackScope,
): Promise<FolderPlan> {
  const changed = new Map<string, Planned>();
  let unchanged = 0;
  let refused = 0;
  let archiveBytes = 0;
  for await (const member of readUstarStream(untilAborted(archive, folder.signal), {
    maxBytes: scope.budget,
    maxMembers: RUN_FILES_MAX_MEMBERS,
  })) {
    if (member.type !== 'file') continue;
    archiveBytes += member.size;
    const key = folder.keyOf(member.path);
    if (key === null) {
      refused += 1;
      continue;
    }
    const seen = `${folder.connectionId}\n${key}`;
    if (scope.handled.has(seen)) continue;
    scope.handled.add(seen);
    const sha256 = await sha256Of(member.body);
    const before = scope.delivered.get(deliveredPath(folder.delivered, folder.prefix, key));
    if (before === sha256) unchanged += 1;
    else changed.set(key, { size: member.size, sha256, delivered: before });
  }
  return { changed, unchanged, refused, archiveBytes };
}

/** Saves one planned file. A conflict keeps the bucket's version; any other failure is counted. */
async function saveFile(
  store: RunWritableConnectionStore,
  folder: Folder,
  key: string,
  item: Planned,
  body: AsyncIterable<Uint8Array>,
  counts: WriteBackCounts,
): Promise<void> {
  const { signal } = folder;
  try {
    let options: { ifNoneMatch: '*' } | { ifMatch: string } = { ifNoneMatch: '*' };
    if (item.delivered !== undefined) {
      // Last write wins unless the bucket moved on: the object must still be the delivered one.
      const current = await unlessAborted(store.read(key, { signal }), signal);
      if (
        current === null ||
        (await sha256Of(untilAborted(current.body, signal))) !== item.delivered
      ) {
        counts.conflicted += 1;
        return;
      }
      options = { ifMatch: current.meta.etag };
    }
    const corrupt = () =>
      new DomainError({
        category: 'conflict',
        code: RUN_FILE_CORRUPT,
        publicMessage: `${RUN_FILE_CORRUPT}: a file changed while it was being saved.`,
      });
    // At the deadline the body errors, and `verified` keeps any part of it out of the bucket.
    await unlessAborted(
      store.write(
        key,
        verified(streamOf(body), { size: item.size, sha256: item.sha256 }, corrupt),
        { ...options, signal },
      ),
      signal,
    );
    counts.written += 1;
    counts.bytes += item.size;
  } catch (cause) {
    if (cause instanceof ObjectConflictError) {
      counts.conflicted += 1;
      return;
    }
    counts.failed += 1;
    // A provider's message can name the key, which is the customer's: only the error's name is logged.
    log.warn('[runs] storage write-back could not write a file', {
      runId: folder.runId,
      connectionId: folder.connectionId,
      reason: cause instanceof Error ? cause.name : 'write_failed',
    });
  }
}

/** Pass 2 re-reads the folder and streams only the planned files to the connection. */
async function saveFolder(
  store: RunWritableConnectionStore,
  archive: ReadableStream<Uint8Array>,
  folder: Folder,
  changed: Map<string, Planned>,
  counts: WriteBackCounts,
): Promise<void> {
  for await (const member of readUstarStream(untilAborted(archive, folder.signal), {
    maxBytes: RUN_FILES_MAX_BYTES,
    maxMembers: RUN_FILES_MAX_MEMBERS,
  })) {
    // Stops between files at the deadline or a stored cancel; the files left count as failed.
    if (folder.signal.aborted) return;
    const key = member.type === 'file' ? folder.keyOf(member.path) : null;
    const item = key === null ? undefined : changed.get(key);
    if (key === null || item === undefined) continue;
    if (!(await folder.stillRunning())) return;
    changed.delete(key);
    await saveFile(store, folder, key, item, member.body, counts);
  }
}

/**
 * The audit row's label: counts and a reason code, built here and from nothing else, so it never
 * holds a key, a path, a name the agent chose, an error message or a credential.
 */
export function writeBackLabel(
  runId: string,
  counts: WriteBackCounts,
  reason: WriteBackRefusal | null,
): string {
  const label = [
    `run ${runId}`,
    `${String(counts.written)} written`,
    `${String(counts.unchanged)} unchanged`,
    `${String(counts.conflicted)} conflicted`,
    `${String(counts.refused)} refused`,
    `${String(counts.failed)} failed`,
    `${String(counts.bytes)} bytes`,
  ].join(' · ');
  return reason === null ? label : `${label} · refused: ${reason}`;
}

/** One audit row per connection that was written, refused, conflicted or failed on. */
async function recordOutcome(
  run: StorageWriteBackRun,
  deps: StorageWriteBackDeps,
  connectionId: string,
  counts: WriteBackCounts,
  reason: WriteBackRefusal | null,
): Promise<void> {
  if (counts.written + counts.conflicted + counts.refused + counts.failed === 0) return;
  const { principal } = run.context;
  const runId = run.context.run.id;
  log.info('[runs] storage write-back finished', { runId, connectionId, reason, ...counts });
  try {
    await within(
      deps.audit({
        workspaceId: principal.workspaceId,
        actorPrincipalId: principal.principalId,
        actorUserId: principal.userId,
        actorLabel: `run ${runId}`,
        action: 'storage-connection-written',
        subjectId: connectionId,
        subjectLabel: writeBackLabel(runId, counts, reason),
      }),
      STORAGE_WRITEBACK_AUDIT_DEADLINE_MS,
    );
  } catch (cause) {
    log.error('[runs] storage write-back audit failed', { runId, connectionId, error: cause });
  }
}

/**
 * Whether the stored run is still `running`. Within an interval of the last read the answer is
 * taken as yes, since a `no` stops the save for good. A store that cannot answer does not stop the
 * save: the deadline still bounds it, and the lookup's failure is logged.
 */
async function isStillRunning(scope: WriteBackScope): Promise<boolean> {
  const now = Date.now();
  if (
    scope.statusReadAt !== null &&
    now - scope.statusReadAt < STORAGE_WRITEBACK_STATUS_INTERVAL_MS
  ) {
    return true;
  }
  scope.statusReadAt = now;
  const runId = scope.run.context.run.id;
  try {
    return await unlessAborted(scope.deps.stillRunning(runId), scope.signal);
  } catch (cause) {
    if (scope.signal.aborted) return false;
    log.warn('[runs] storage write-back could not read the run status', {
      runId,
      reason: cause instanceof Error ? cause.name : 'status_unavailable',
    });
    return true;
  }
}

/** The grant as it is now for one delivered folder, once every gate allows it, or why not. */
async function openGrant(
  scope: WriteBackScope,
  target: DeliveredFolder,
): Promise<WriteBackRefusal | StorageGrantRef> {
  const { run, fresh } = scope;
  if (!scope.runWrites) return 'run_cannot_write';
  if (!target.hydratedSame) return 'folder_mismatch';
  const grant = fresh?.assignments.storageGrants?.find(
    (candidate) =>
      candidate.connectionId === target.connectionId &&
      candidate.prefix === target.prefix &&
      candidate.access === 'read-write',
  );
  if (fresh === null || grant === undefined) return 'grant_missing';
  if (!fresh.agent.permissions.writeFiles) return 'agent_cannot_write';
  const connection = await unlessAborted(
    scope.deps.connections.get(run.context.principal.workspaceId, target.connectionId),
    scope.signal,
  );
  if (connection === null) return 'connection_missing';
  if (!connection.writeAllowed) return 'write_not_allowed';
  const allowed = connection.allowedPrefixes.some((prefix) =>
    isUnderAllowedPrefix(grant.prefix, prefix),
  );
  return allowed ? grant : 'prefix_not_allowed';
}

/** Writes one delivered folder back; answers why it was refused, or `null`. */
async function writeBackFolder(
  scope: WriteBackScope,
  target: DeliveredFolder,
  counts: WriteBackCounts,
): Promise<WriteBackRefusal | null> {
  const { run } = scope;
  const grant = await openGrant(scope, target);
  if (typeof grant === 'string') return grant;
  const path = `${run.cwd}/${target.path}`;
  const folder: Folder = {
    runId: run.context.run.id,
    connectionId: target.connectionId,
    prefix: target.prefix,
    delivered: target.path,
    path,
    keyOf: keyResolver(grant, scope, target, path),
    signal: scope.signal,
    stillRunning: async () => {
      if (await isStillRunning(scope)) return true;
      scope.stop();
      return false;
    },
  };
  let plan: FolderPlan;
  try {
    const archive = await unlessAborted(run.collect(path), scope.signal);
    if (archive === null) return null;
    plan = await planFolder(archive, folder, scope);
  } catch (cause) {
    if (scope.signal.aborted) return stopReason(scope.signal);
    log.warn('[runs] storage write-back could not read a folder', {
      runId: folder.runId,
      connectionId: target.connectionId,
      reason: cause instanceof Error ? cause.name : 'archive_unreadable',
    });
    return 'archive_refused';
  }
  scope.budget -= plan.archiveBytes;
  counts.unchanged += plan.unchanged;
  counts.refused += plan.refused;
  if (plan.changed.size === 0) return null;

  try {
    const store = await unlessAborted(
      scope.deps.connections.openWritable(
        run.context.principal.workspaceId,
        target.connectionId,
        scope.signal,
      ),
      scope.signal,
    );
    const archive = await unlessAborted(run.collect(path), scope.signal);
    if (archive === null) throw new Error('the folder vanished between the two reads');
    await saveFolder(store, archive, folder, plan.changed, counts);
  } catch (cause) {
    log.warn('[runs] storage write-back stopped reading a folder', {
      runId: folder.runId,
      connectionId: target.connectionId,
      reason: cause instanceof Error ? cause.name : 'archive_unreadable',
    });
  }
  // Planned files the second read never reached were not written.
  const left = plan.changed.size;
  counts.failed += left;
  return scope.signal.aborted && left > 0 ? stopReason(scope.signal) : null;
}

/** The folders the body delivered `read-write` that the loader delivered for a storage grant. */
function deliveredFolders(
  run: StorageWriteBackRun,
  files: BodyFiles,
): ReadonlyMap<string, readonly DeliveredFolder[]> {
  const byConnection = new Map<string, DeliveredFolder[]>();
  for (const file of files) {
    if (file.kind !== 'directory' || file.access !== 'read-write') continue;
    const grant = run.folders.get(file.path);
    if (grant === undefined) continue;
    const hydrated = run.hydrated?.get(file.path);
    const hydratedSame =
      run.hydrated === undefined ||
      (hydrated?.connectionId === grant.connectionId && hydrated.prefix === grant.prefix);
    const list = byConnection.get(grant.connectionId) ?? [];
    list.push({
      connectionId: grant.connectionId,
      prefix: grant.prefix,
      path: file.path,
      hydratedSame,
    });
    byConnection.set(grant.connectionId, list);
  }
  return byConnection;
}

/** Writes one connection's folders back; a refusal is counted and named, never thrown. */
async function writeBackConnection(
  scope: WriteBackScope,
  folders: readonly DeliveredFolder[],
  counts: WriteBackCounts,
): Promise<WriteBackRefusal | null> {
  const { run, signal } = scope;
  let reason: WriteBackRefusal | null = null;
  for (const target of folders) {
    const failedBefore = counts.failed;
    let refused: WriteBackRefusal | null;
    try {
      refused = signal.aborted ? stopReason(signal) : await writeBackFolder(scope, target, counts);
    } catch {
      refused = signal.aborted ? stopReason(signal) : 'connection_unavailable';
    }
    if (refused === null) continue;
    reason ??= refused;
    // A stop met while saving has counted what it left as failed; anything else refuses the grant.
    if (counts.failed === failedBefore) counts.refused += 1;
    log.warn('[runs] storage write-back refused a grant', {
      runId: run.context.run.id,
      connectionId: target.connectionId,
      reason: refused,
    });
  }
  return reason;
}

/**
 * Answers the counts by connection id, for the caller's tests; the launcher ignores them. A
 * connection's audit row is recorded as soon as its folders end, so a later failure cannot lose it.
 */
export async function writeBackStorage(
  run: StorageWriteBackRun,
  deps: StorageWriteBackDeps,
): Promise<ReadonlyMap<string, WriteBackCounts>> {
  const { context } = run;
  const body = RunBodySchema.safeParse(run.body);
  if (!body.success) return new Map();
  const targets = deliveredFolders(run, body.data.resources.files);
  if (targets.size === 0) return new Map();

  let fresh: RunAgent | null = null;
  try {
    fresh = await unlessAborted(
      deps.readRunAgent(
        context.principal.workspaceId,
        context.agent.id,
        context.session.agentVersionId ?? null,
      ),
      run.signal,
    );
  } catch {
    log.warn('[runs] storage write-back refused: the run grants are unavailable', {
      runId: context.run.id,
    });
  }
  const stopped = new AbortController();
  const scope: WriteBackScope = {
    run,
    signal: AbortSignal.any([run.signal, stopped.signal]),
    stop: () => {
      stopped.abort(new Error('the run is no longer running'));
    },
    deps,
    runWrites: body.data.portable.permissions.writeFiles,
    fresh,
    delivered: new Map(
      body.data.resources.files.flatMap((file) =>
        file.sha256 === undefined ? [] : [[file.path, file.sha256] as const],
      ),
    ),
    launchReadOnly: launchReadOnlyPaths(body.data.resources.files),
    handled: new Set<string>(),
    budget: RUN_FILES_MAX_BYTES,
    statusReadAt: null,
  };

  const totals = new Map<string, WriteBackCounts>();
  for (const [connectionId, folders] of targets) {
    const counts = newCounts();
    totals.set(connectionId, counts);
    const reason = await writeBackConnection(scope, folders, counts);
    await recordOutcome(run, deps, connectionId, counts, reason);
  }
  return totals;
}
