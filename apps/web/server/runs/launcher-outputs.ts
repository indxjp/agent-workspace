import {
  ArchiveTooLargeError,
  archiveWorkspacePaths,
  RUN_FILES_MAX_BYTES,
} from '@agent-workspace/runtime/transfer';
import {
  AGENT_MEMORY_DIRECTORY,
  AGENT_MEMORY_MAX_BYTES,
  AGENT_MEMORY_MAX_FILES,
  AgentPermissionsSchema,
  agentMemoryEnabled,
  agentMemoryFolder,
} from '@indx-workspace/contracts/agents';
import { z } from 'zod';
import { type RelayOutcome } from './relay';
import { publicRunFailure } from './failures';
import { InfrastructureError } from '../errors';
import type { LaunchContext } from './environment';
import type { RunStore } from './store';
import type { RuntimeLaunchTarget } from '../compose/runtime-profile';
import { relativeRuntimePath } from '../runtimes/contract';
import { memoryLimitExceeded } from '../compose/agent-memory';
import { type RunnerLauncherOptions, type RuntimeWorkspaceLifecycle } from './launcher-contract';
import { runtimeHttpFailure } from './launcher-hydration';

/*
 * What the body the runtime was actually sent says about where a run writes. A projection, not a
 * contract: a body without both fields (a test stub) simply has no `outputs/` to collect. The
 * fields sit where `RunRequest` puts them: the composed permissions are under `portable`.
 */
const RunOutputScopeSchema = z.object({
  cwd: z.string(),
  portable: z.object({ permissions: z.object({ writeFiles: z.boolean() }) }),
});

/*
 * The same projection for the memory folder (ADR-0163): the composed permissions in full, so a
 * body whose permissions keep no memory (or a test stub) has no `memory/` to collect.
 */
const RunMemoryScopeSchema = z.object({
  cwd: z.string(),
  portable: z.object({ permissions: AgentPermissionsSchema }),
});

/**
 * The most bytes a memory folder's archive may take on the wire: its file bytes, plus a header and
 * padding for each file and for as many directories again, plus the terminator. Past it the folder
 * is over its bounds, so it is refused by name without being read whole.
 */
const MEMORY_ARCHIVE_MAX_BYTES = AGENT_MEMORY_MAX_BYTES + (2 * AGENT_MEMORY_MAX_FILES + 2) * 1024;

/** An archive past the byte cap of its collection; a memory collection names it. */
class ArchiveOverCapError extends Error {
  override readonly name = 'ArchiveOverCapError';
}

const RunnerFileNotFoundSchema = z.object({ error: z.literal('file_not_found') });

/** The part of a run's `cwd` below the runtime's workspace root; a `cwd` outside the root throws. */
function cwdBelowRoot(cwdOfBody: string, target: RuntimeLaunchTarget): string {
  const root = `${target.workspaceRoot.replaceAll('\\', '/').replace(/\/+$/u, '')}/`;
  const cwd = cwdOfBody.replaceAll('\\', '/');
  if (!cwd.startsWith(root)) {
    throw new Error(`run directory ${JSON.stringify(cwd)} is outside ${JSON.stringify(root)}`);
  }
  return cwd.slice(root.length);
}

/** The runtime-root-relative `<workspace>/<session>/outputs` of a run allowed to write files. */
function outputsDirectory(body: unknown, target: RuntimeLaunchTarget): string | null {
  const scope = RunOutputScopeSchema.safeParse(body);
  if (!scope.success || !scope.data.portable.permissions.writeFiles) return null;
  return relativeRuntimePath(`${cwdBelowRoot(scope.data.cwd, target)}/outputs`);
}

/**
 * The runtime-root-relative `<workspace>/<session>/memory` of a run that keeps a memory folder, and
 * the folder it is written back to, or null (ADR-0163).
 */
function memoryDirectory(
  body: unknown,
  target: RuntimeLaunchTarget,
  context: LaunchContext,
): { readonly directory: string; readonly folder: string } | null {
  const scope = RunMemoryScopeSchema.safeParse(body);
  if (!scope.success || !agentMemoryEnabled(scope.data.portable.permissions)) return null;
  return {
    directory: relativeRuntimePath(
      `${cwdBelowRoot(scope.data.cwd, target)}/${AGENT_MEMORY_DIRECTORY}`,
    ),
    folder: agentMemoryFolder(context.agent.id),
  };
}

/** Reads the whole body, so call it on a clone: an unread tee branch makes the other's cancel hang. */
async function isFileNotFound(response: Response): Promise<boolean> {
  const parsed: unknown = await response.json().catch(() => null);
  return RunnerFileNotFoundSchema.safeParse(parsed).success;
}

export interface OutputCollection {
  readonly lifecycle: RuntimeWorkspaceLifecycle | undefined;
  readonly context: LaunchContext;
  readonly target: RuntimeLaunchTarget | undefined;
  readonly base: string;
  readonly doFetch: typeof globalThis.fetch;
  readonly maxBytes: number;
  readonly requestHeaders: Readonly<Record<string, string>>;
  /** The body the runtime was sent, which says where the run writes. */
  readonly body: unknown;
  /** Only a run that ended `completed` within its lifetime has its `outputs/` collected. */
  readonly outcome: RelayOutcome;
  readonly lifetimeExpired: boolean;
}

/**
 * Read a response body, counting the bytes as they arrive and cancelling the stream once they pass
 * `maxBytes`: a chunked archive declares no `Content-Length`, so the header check alone is not a cap.
 */
async function readCappedArchive(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ArchiveOverCapError(`runtime output archive exceeds ${String(maxBytes)} bytes`);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks, length));
}

/** `GET /files` for `paths`: the response, or `null` for a missing path when `tolerateMissing`. */
async function fetchRuntimeArchive(
  input: OutputCollection,
  paths: readonly string[],
  tolerateMissing: boolean,
): Promise<Response | null> {
  const query = new URLSearchParams();
  for (const path of paths) query.append('path', path);
  const response = await input.doFetch(`${input.base}/files?${query.toString()}`, {
    method: 'GET',
    headers: { ...input.requestHeaders, Accept: 'application/x-tar' },
  });
  if (!response.ok) {
    // An `outputs/` the agent never created is not a failure; a missing `persistPaths` entry is.
    if (tolerateMissing && response.status === 404) {
      if (await isFileNotFound(response.clone())) return null;
    }
    throw new InfrastructureError({
      component: 'runtime',
      operation: 'collect-workspace-outputs',
      failureKind: 'upstream',
      cause: await runtimeHttpFailure(response),
    });
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > input.maxBytes) {
    throw new ArchiveOverCapError(`runtime output archive exceeds ${String(input.maxBytes)} bytes`);
  }
  return response;
}

async function promoteFromRuntime(
  input: OutputCollection & {
    readonly lifecycle: RuntimeWorkspaceLifecycle;
    readonly target: RuntimeLaunchTarget;
  },
  paths: readonly string[],
  outputsBase?: string,
  memoryFolder?: string,
): Promise<void> {
  const response = await fetchRuntimeArchive(input, paths, outputsBase !== undefined);
  if (response === null) return;
  const archive = await readCappedArchive(response, input.maxBytes);
  await input.lifecycle.promoteOutputs(
    input.context,
    input.target,
    archive,
    outputsBase === undefined
      ? undefined
      : { base: outputsBase, ...(memoryFolder === undefined ? {} : { target: memoryFolder }) },
  );
}

/**
 * `maxBytes` caps archive wire bytes; files collected on this host also stay within the payload
 * limit a runner's `GET /files` enforces, so tar framing never buys extra file data.
 */
function localPayloadBytes(input: OutputCollection): number {
  return Math.min(input.maxBytes, RUN_FILES_MAX_BYTES);
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * A `local` run's `outputs/` is on this host, under the same root its `cwd` is (issue #1576): it is
 * archived from disk, with the same byte cap and confinement as the runner's own `GET /files`.
 */
async function promoteFromLocalWorkspace(
  input: OutputCollection & {
    readonly lifecycle: RuntimeWorkspaceLifecycle;
    readonly target: RuntimeLaunchTarget;
  },
  directory: string,
  memoryFolder?: string,
): Promise<void> {
  let archive: Uint8Array;
  try {
    archive = await readCappedArchive(
      new Response(
        await archiveWorkspacePaths(input.target.workspaceRoot, [directory], {
          maxBytes: localPayloadBytes(input),
        }),
      ),
      input.maxBytes,
    );
  } catch (cause) {
    // An `outputs/` the agent never created is not a failure.
    if (isMissingPath(cause)) return;
    throw cause;
  }
  await input.lifecycle.promoteOutputs(input.context, input.target, archive, {
    base: directory,
    ...(memoryFolder === undefined ? {} : { target: memoryFolder }),
  });
}

/**
 * Write a completed run's `memory/` back to its agent's memory folder (ADR-0163), collected like
 * `outputs/` but capped at the memory bounds: an archive past them is `memory_limit_exceeded`,
 * refused before it is read whole and before anything is written. A symlink anywhere in it is
 * refused by the archive itself, on the runner and on this host alike.
 */
async function promoteMemory(
  input: OutputCollection & {
    readonly lifecycle: RuntimeWorkspaceLifecycle;
    readonly target: RuntimeLaunchTarget;
  },
  memory: { readonly directory: string; readonly folder: string },
): Promise<void> {
  const capped = { ...input, maxBytes: Math.min(input.maxBytes, MEMORY_ARCHIVE_MAX_BYTES) };
  try {
    if (input.target.fileTransfer === 'local-disk') {
      await promoteFromLocalWorkspace(capped, memory.directory, memory.folder);
    } else {
      await promoteFromRuntime(capped, [memory.directory], memory.directory, memory.folder);
    }
  } catch (cause) {
    if (cause instanceof ArchiveOverCapError || cause instanceof ArchiveTooLargeError) {
      throw memoryLimitExceeded();
    }
    throw cause;
  }
}

/**
 * Collect what a run left behind into `runs/<runId>/outputs/`: the profile's `persistPaths` after
 * any outcome, and the agent's own `outputs/` directory after a completed run that could write files.
 * A completed run that keeps a memory folder also writes its `memory/` back to it (ADR-0163); a run
 * that did not complete writes nothing back there.
 */
export async function collectRuntimeOutputs(input: OutputCollection): Promise<string | null> {
  const { lifecycle, target } = input;
  if (lifecycle === undefined || target === undefined) return null;
  const ready = { ...input, lifecycle, target };
  const persistPaths = target.persistPaths ?? [];
  // Two independent collections: a bad persist path must not cost the run its outputs/.
  const persisted =
    persistPaths.length === 0
      ? null
      : await collectionFailure(() =>
          promoteFromRuntime(ready, persistPaths.map(relativeRuntimePath)),
        );
  if (input.outcome.kind !== 'completed' || input.lifetimeExpired) return persisted;
  const outputs = await collectionFailure(async () => {
    const directory = outputsDirectory(input.body, target);
    if (directory === null) return;
    // A local-disk runner shares this host's workspace, mirroring the hydrate path (issue #1576).
    if (target.fileTransfer === 'local-disk') await promoteFromLocalWorkspace(ready, directory);
    else await promoteFromRuntime(ready, [directory], directory);
  });
  const memory = await collectionFailure(async () => {
    const folder = memoryDirectory(input.body, target, input.context);
    if (folder !== null) await promoteMemory(ready, folder);
  });
  return persisted ?? outputs ?? memory;
}

/**
 * Whether a relayed run concludes `completed`, decided before anything is stored: it completed
 * within its lifetime, its outputs were saved, and it answered the output schema it was asked for.
 */
export function concludesCompleted(
  context: LaunchContext,
  outcome: RelayOutcome,
  persistenceFailure: string | null,
  lifetimeExpired: boolean,
): boolean {
  return (
    !lifetimeExpired &&
    outcome.kind === 'completed' &&
    persistenceFailure === null &&
    (context.outputSchema === undefined || (outcome.output?.structured ?? null) !== null)
  );
}

/**
 * Save the read-write storage folders of a run decided `completed`, while it is still `running`:
 * its session stays busy, so no next run hydrates over the folders before they are saved. A run
 * already terminal (an interrupt on another replica) is not saved. Never throws, and never changes
 * the outcome. `signal` is made once the save starts, from the stored run's `startedAt`, so its
 * deadline counts from then.
 */
export async function writeBackRunStorage(
  input: OutputCollection,
  store: RunStore,
  storageWriteback: RunnerLauncherOptions['storageWriteback'],
  signal: (storedStartedAt: Date | null) => AbortSignal,
): Promise<void> {
  const { target } = input;
  if (storageWriteback === undefined || target === undefined) return;
  try {
    const stored = await store.get(input.context.run.id);
    if (stored?.status !== 'running') return;
    const scope = RunOutputScopeSchema.pick({ cwd: true }).safeParse(input.body);
    if (!scope.success) return;
    await storageWriteback({
      context: input.context,
      body: input.body,
      signal: signal(stored.startedAt),
      cwd: relativeRuntimePath(cwdBelowRoot(scope.data.cwd, target)),
      collect: async (path) => {
        if (target.fileTransfer === 'local-disk') {
          try {
            return await archiveWorkspacePaths(target.workspaceRoot, [path], {
              maxBytes: localPayloadBytes(input),
            });
          } catch (cause) {
            if (isMissingPath(cause)) return null;
            throw cause;
          }
        }
        return (await fetchRuntimeArchive(input, [path], true))?.body ?? null;
      },
    });
  } catch (cause) {
    publicRunFailure(cause, {
      operation: 'write-back-storage',
      failureKind: 'upstream',
      publicMessage: 'Run storage could not be saved.',
    });
  }
}

/** Run one output collection; answer its public failure message, or `null` when it succeeded. */
async function collectionFailure(collect: () => Promise<void>): Promise<string | null> {
  try {
    await collect();
    return null;
  } catch (cause) {
    return publicRunFailure(cause, {
      operation: 'collect-workspace-outputs',
      failureKind: 'upstream',
      publicMessage: 'Run output could not be saved.',
    });
  }
}
