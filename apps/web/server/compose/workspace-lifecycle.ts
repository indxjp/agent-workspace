import { createHash } from 'node:crypto';

import { toObjectKey, UnsafeObjectKeyError } from '@agent-workspace/core/storage/keys';
import {
  bytesToStream,
  decodeUstar,
  encodeUstarStream,
  RUN_FILES_MAX_ARCHIVE_BYTES,
  RUN_FILES_MAX_BYTES,
  type StreamTarEntry,
  type TarEntry,
} from '@agent-workspace/runtime/transfer';
import { RUN_FILE_CORRUPT } from '@indx-workspace/contracts/runs';

import { DomainError } from '../errors';
import type { LaunchContext } from '../runs/environment';
import type { RuntimeWorkspaceLifecycle } from '../runs/launcher';
import type { StorageContext, StorageService } from '../storage/service';
import { log } from '../telemetry/logger';
import type { RuntimeLaunchTarget } from './runtime-profile';
import {
  assertRunFilesFit,
  loadAttachedFiles,
  runInputFiles,
  skillInboxPath,
  type AgentRunResourceLoader,
  type AgentRunResourceSelection,
  type RunFileSource,
} from './resource-loader';

export interface RuntimeWorkspaceLifecycleDependencies {
  /** Loads the run's attachments by file id. */
  readonly resources: AgentRunResourceLoader;
  /**
   * The run's granted files and skills, loaded as compose loads them: the session's pinned
   * version's assignments (issue #612), the project's files (issue #125), within the policy ceiling.
   */
  readonly granted: (
    context: LaunchContext,
  ) => Promise<Pick<AgentRunResourceSelection, 'files' | 'skills' | 'sources'>>;
  /** The catalog service: outputs save into area `artifacts` through it. */
  readonly storage: StorageService;
}

/** The storage-side corruption of one run input: logged with its object id, never its bytes. */
function corrupt(runId: string, source: RunFileSource): DomainError {
  log.error('[runs] a run input does not match its catalog row', {
    runId,
    objectId: source.objectId,
  });
  return new DomainError({
    category: 'conflict',
    code: RUN_FILE_CORRUPT,
    publicMessage: `${RUN_FILE_CORRUPT}: a granted file's stored bytes do not match its checksum; upload it again.`,
  });
}

/**
 * `body` passed through one chunk at a time while its size and SHA-256 are checked against the
 * row's: a mismatch errors the stream, which aborts the archive and fails the run. Pulled on demand
 * (high-water mark 0), so backpressure reaches the object read.
 */
// @story US-STO-06
export function verified(
  body: ReadableStream<Uint8Array>,
  expected: { readonly size: number; readonly sha256: string | null },
  fail: () => DomainError,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const hash = expected.sha256 === null ? null : createHash('sha256');
  let seen = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          if (seen !== expected.size || (hash !== null && hash.digest('hex') !== expected.sha256)) {
            controller.error(fail());
            return;
          }
          controller.close();
          return;
        }
        seen += value.byteLength;
        if (seen > expected.size) {
          await reader.cancel().catch(() => undefined);
          controller.error(fail());
          return;
        }
        hash?.update(value);
        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
}

/** One referenced file as a lazily opened archive member, checked as it streams. */
function fileEntry(
  runId: string,
  path: string,
  mode: number,
  reference: { readonly size: number; readonly sha256: string },
  source: RunFileSource | undefined,
): StreamTarEntry {
  if (source === undefined) throw new Error('a run file reference has no source to read it from');
  return {
    path,
    type: 'file',
    mode,
    size: reference.size,
    open: async () => {
      const body = await source.open();
      // Deleted or replaced since the run's files were loaded: a race, not corruption.
      if (body === null) {
        log.warn('[runs] a run input disappeared before it was read', {
          runId,
          objectId: source.objectId,
        });
        throw new Error('a granted file disappeared before the run read it');
      }
      // A customer's object has no checksum yet: only its size is held to the listing, and the
      // archive reports the digest it saw (the storage design, §05).
      const expected =
        source.streamed === true ? { size: reference.size, sha256: null } : reference;
      return verified(body, expected, () => corrupt(runId, source));
    },
  };
}

const OUTPUTS_PREFIX = (runId: string): string => `runs/${runId}/outputs/`;

/**
 * The durable key of one collected file: always `runs/<runId>/outputs/<path>`, so a run can never
 * write a bare workspace path. `base` is a directory the entry must sit under; it is stripped first.
 * Refuses an entry outside `base` and an empty remainder.
 */
export function runOutputKey(runId: string, entryPath: string, base?: string): string {
  let remainder = entryPath;
  if (base !== undefined) {
    const directory = `${base.replace(/\/+$/u, '')}/`;
    if (!entryPath.startsWith(directory)) {
      throw new Error(`output ${JSON.stringify(entryPath)} is outside ${JSON.stringify(base)}`);
    }
    remainder = entryPath.slice(directory.length);
  }
  if (remainder.length === 0) {
    throw new Error(`output ${JSON.stringify(entryPath)} has no storable name`);
  }
  return `${OUTPUTS_PREFIX(runId)}${remainder}`;
}

/**
 * The object store's own key rule, checked before any write: an archive member such as `50%.txt`
 * is legal in a tar but refused by `put`, which would leave a half-promoted run behind. The error
 * message names the archive entry's index and the rule, not the agent-chosen name.
 */
function storableOutputKey(index: number, key: string): string {
  try {
    return toObjectKey(key);
  } catch (cause) {
    if (!(cause instanceof UnsafeObjectKeyError)) throw cause;
    throw new Error(
      `output entry ${String(index)} has a name the object store refuses (${cause.rule})`,
      { cause },
    );
  }
}

/**
 * The archive is staged first (a row no list shows), each output is saved into area `artifacts`,
 * and the staging row goes once all are saved. A failure part-way removes the outputs this call
 * added and the staging row, so nothing partial stays visible; an output that replaced an earlier
 * one stays (its bytes are complete and newer), and a delete that fails leaves its row for the
 * cleanup job.
 */
// @story US-STO-07
async function promoteThroughStorage(
  storage: StorageService,
  context: LaunchContext,
  archive: Uint8Array,
  files: readonly { readonly key: string; readonly entry: TarEntry }[],
): Promise<void> {
  const ctx: StorageContext = {
    workspaceId: context.principal.workspaceId,
    principalId: context.principal.ownerPrincipalId,
    userId: context.principal.userId,
  };
  if (files.length === 0) return;
  const staged = await storage.stage(ctx, bytesToStream(archive), RUN_FILES_MAX_ARCHIVE_BYTES);
  if (!staged.ok) throw new Error('the outputs archive is larger than the staging limit');
  const saved: string[] = [];
  try {
    for (const { key, entry } of files) {
      // A file an earlier promotion saved keeps this call's complete, newer bytes on rollback.
      const existed = (await storage.get(ctx, 'files', key)) !== null;
      const result = await storage.save(ctx, {
        area: 'artifacts',
        path: key,
        body: bytesToStream(entry.data ?? new Uint8Array()),
        maxBytes: RUN_FILES_MAX_BYTES,
        replace: true,
      });
      if (!result.ok) throw new Error(`an output could not be saved (${result.code})`);
      if (!existed) saved.push(key);
    }
  } catch (error) {
    const cleanup = await Promise.allSettled([
      ...saved.map((path) => storage.remove(ctx, 'artifacts', path, { recursive: false })),
      storage.unstage(ctx, staged.row),
    ]);
    const failed: unknown[] = [];
    for (const step of cleanup) {
      if (step.status === 'rejected') failed.push(step.reason);
    }
    throw failed.length === 0
      ? error
      : new AggregateError([error, ...failed], 'the promotion failed and so did its cleanup');
  }
  await storage.unstage(ctx, staged.row);
}

/**
 * Bridges the tenant-scoped control-plane object store to an isolated runtime workspace.
 *
 * Inputs are rebuilt for every run from the assignments the run's agent configuration has. Outputs are
 * parsed and path-validated in full before any durable object is touched.
 */
export function createRuntimeWorkspaceLifecycle(
  dependencies: RuntimeWorkspaceLifecycleDependencies,
): RuntimeWorkspaceLifecycle {
  return {
    /**
     * One archive of every file the run's `/run` body references (the storage design, §04): grants,
     * attachments and skill files, each under the run's cwd (`<workspaceId>/<sessionId>/`, which
     * the runner resolves under its workspace root), where the runner checks them. The total is
     * judged here, before anything is read; the returned stream opens one object at a time, only
     * as it is pulled.
     */
    // @story US-STO-06
    async inputArchive(context: LaunchContext, onDigest?: (path: string, sha256: string) => void) {
      const workspaceId = context.principal.workspaceId;
      const [granted, attached] = await Promise.all([
        dependencies.granted(context),
        // @story US-STO-11
        loadAttachedFiles(dependencies.resources, workspaceId, context.attachments ?? []),
      ]);
      // Compose refuses a widening scope; here the scope is a filter only.
      const files = runInputFiles(granted.files, attached.files, context.fileScope);
      assertRunFilesFit(files, granted.skills);
      const sources = new Map([...(granted.sources ?? []), ...(attached.sources ?? [])]);
      const cwd = `${workspaceId}/${context.session.id}/`;
      const runId = context.run.id;
      const entries: StreamTarEntry[] = [
        ...files.map((file): StreamTarEntry =>
          file.kind === 'directory'
            ? { path: `${cwd}${file.path}`, type: 'directory', mode: 0o755 }
            : fileEntry(
                runId,
                `${cwd}${file.path}`,
                file.access === 'read-write' ? 0o644 : 0o444,
                file,
                sources.get(file.path),
              ),
        ),
        ...granted.skills.flatMap((skill) =>
          skill.files.map((file) => {
            const inbox = skillInboxPath(skill.name, file.path);
            return fileEntry(runId, `${cwd}${inbox}`, 0o444, file, sources.get(inbox));
          }),
        ),
      ];
      return entries.length === 0
        ? null
        : encodeUstarStream(entries, {
            maxBytes: RUN_FILES_MAX_BYTES,
            ...(onDigest === undefined
              ? {}
              : { onEntryDigest: (path, sha256) => onDigest(path.slice(cwd.length), sha256) }),
          });
    },

    async promoteOutputs(
      context: LaunchContext,
      _runtime: RuntimeLaunchTarget,
      archive: Uint8Array,
      options?: { readonly base?: string },
    ) {
      // Decode and map every key first: checksum, member type, traversal and prefix failures must
      // leave durable state untouched.
      const entries = decodeUstar(archive);
      const runId = context.run.id;
      const files = entries.flatMap((entry, index) =>
        entry.type === 'file'
          ? [
              {
                key: storableOutputKey(index, runOutputKey(runId, entry.path, options?.base)),
                entry,
              },
            ]
          : [],
      );
      await promoteThroughStorage(dependencies.storage, context, archive, files);
    },
  };
}
