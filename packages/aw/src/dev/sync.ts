import {
  ApiProblemError,
  ContractViolationError,
  TransportError,
  createClient,
  type AgentWorkspaceClient,
} from '@indx-workspace/sdk';
import path from 'node:path';
import type { EngineId } from '@indx-workspace/contracts/engines';
import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';
import type { LocalRuntimeStartMessage } from '@indx-workspace/contracts/local-runtime';
import type { ProjectDocument, ProjectRead } from '@indx-workspace/contracts/project-file';
import { CommandRefusedError, UsageError, type CliIo } from '../io.js';
import { applyProjectTools } from '../local-runtime/project-resources.js';
import type { LocalRuntimeSession } from '../local-runtime/supervisor.js';
import { pushProject, type LoadedCodeTool, type LoadedTool } from '../project/index.js';
import type { LoadProjectOptions } from '../project/load.js';
import { madeByAwDev } from '../project/tool-host.js';
import { problemsFromError, type ProjectProblem } from '../project/problems.js';
import { createProjectFileSync } from './sync-project-file.js';
import { createSyncReporter } from './sync-report.js';
import { watchProject } from './watch.js';

/**
 * How long `aw dev` waits after the last save before syncing: an editor's save is often several
 * events (a write, a rename, an attribute change), and a burst of saves is one sync.
 */
const DEV_SYNC_DEBOUNCE_MS = 200;

/**
 * How long one request of a sync waits for the runtime's response headers. Without a deadline a
 * runtime that accepts a request and never answers holds the sync forever: every later save only
 * marks it dirty and `aw dev` goes silent. At the deadline the request fails as a
 * {@link TransportError}, said as `sync: ...`, and the next save retries.
 */
export const DEV_SYNC_TIMEOUT_MS = 30_000;

export interface DevSyncClientOptions {
  /** The runtime's origin the credential was issued for. */
  readonly baseUrl: string;
  /** The local workspace's API key the runtime issued to this `aw dev` (ADR-0109, S1-21). */
  readonly apiKey: string;
  readonly fetch: typeof fetch;
}

/** The SDK client a sync writes through: the runtime `aw dev` started, with a bounded wait. */
export function createDevSyncClient(options: DevSyncClientOptions): AgentWorkspaceClient {
  return createClient({
    baseUrl: options.baseUrl,
    auth: { kind: 'api-key', apiKey: options.apiKey },
    fetch: options.fetch,
    timeoutMs: DEV_SYNC_TIMEOUT_MS,
  });
}

/**
 * ADR-0115: make `local` hold the connector `aw-dev-tools` at the tool host's URL, which changes on
 * every `aw dev` start, so a version listing code tools resolves it. Created when absent, else
 * patched when its URL differs; one aw dev did not create (a credential, another transport or host)
 * is refused, never re-pointed, so its stored auth never reaches the host. It carries no credential: the URL's token is the only secret and
 * never leaves this machine. A refusal is a problem against the file that declares a code tool.
 */
async function registerToolHost(
  client: AgentWorkspaceClient,
  url: string,
  codeTools: readonly LoadedCodeTool[],
  signal: AbortSignal,
): Promise<readonly ProjectProblem[]> {
  try {
    const existing = (await client.connectors.list({ signal })).find(
      (connector) => connector.name === AW_DEV_TOOLS_CONNECTOR,
    );
    if (existing !== undefined && !madeByAwDev(existing)) {
      const [first] = codeTools;
      return [
        {
          file: first?.file ?? '.',
          status: null,
          code: 'tool_host_connector_conflict',
          details: [`connector:${AW_DEV_TOOLS_CONNECTOR}`],
          hint: `a connector named ${AW_DEV_TOOLS_CONNECTOR} that aw dev did not create already exists; aw dev will not re-point it, so rename or delete it, then save again`,
        },
      ];
    }
    if (existing === undefined) {
      await client.connectors.create(
        { name: AW_DEV_TOOLS_CONNECTOR, transport: 'http', url },
        { signal },
      );
    } else if (existing.url !== url || !existing.enabled) {
      await client.connectors.update(existing.id, { url, enabled: true }, { signal });
    }
    return [];
  } catch (error) {
    if (signal.aborted) throw error;
    const [first] = codeTools;
    return problemsFromError(error, first?.file ?? '.', []);
  }
}

export interface DevSyncOptions {
  /** A client for the runtime this `aw dev` started, signed in with its own credential. */
  readonly client: AgentWorkspaceClient;
  /** The project's directory, absolute. */
  readonly root: string;
  readonly io: CliIo;
  /** Aborted when `aw dev` stops: the watchers close and no sync starts after it. */
  readonly signal: AbortSignal;
  /**
   * The origin the runtime said it is ready on (`ready <url>`): the page, try and widget lines
   * point there, so every C5 line names the same URL.
   */
  readonly origin: string;
  /** Surfaces whose page, try and widget lines are already on screen: the first sync skips them. */
  readonly announcedSurfaces?: readonly string[];
  readonly debounceMs?: number;
  /** The project file's `engine`, for an agent that names none (C12). */
  readonly defaultEngine?: EngineId | undefined;
  /** The project file's `models`, which an `.agent.md` model is matched to (ADR-0166 D12). */
  readonly models?: LoadProjectOptions['models'];
  /** The secret names withheld from the runtime when it was forked (SD17). */
  readonly forkWithheld: readonly string[];
  /** The project file as planned at start: its `connectors` names are not a tool's (SD1). */
  readonly project: ProjectDocument;
  /**
   * What a save of `agent-workspace.yaml` is applied with (issue #695): the file as read at start
   * and the start-up inputs `applyProjectResources` took. Absent, a save of the file is not read.
   */
  readonly liveProject?: {
    readonly read: ProjectRead;
    readonly start: LocalRuntimeStartMessage;
    readonly session: LocalRuntimeSession;
    readonly anthropicBaseUrl: string | undefined;
  };
  /** The tool host `aw dev` started for `defineTool()` run files (issue #693); absent in tests. */
  readonly toolHost?: { readonly url: string } | undefined;
  /** An error no file can fix and no retry will clear. The loop has stopped when it is called. */
  readonly onFatal: (error: Error) => void;
}

export interface DevSync {
  /** Settles once the first sync, with its output, is done. */
  readonly firstSync: Promise<void>;
  /** Settles once the watchers and the debounce timer are released and no sync is running. */
  readonly closed: Promise<void>;
}

/**
 * A Node filesystem error (`EPERM`, `EACCES`, `EBUSY`, `EMFILE`, ...) on a path inside the
 * project: an unreadable or locked `agents/` or `surfaces/` — on Windows often only for a moment,
 * an antivirus scan or an editor's lock — is the user's to fix while `aw dev` runs, so it is
 * said like a refusal. One on a path outside the project is not, and stays fatal.
 */
function isProjectFileSystemError(error: unknown, root: string): error is Error {
  if (!(error instanceof Error)) return false;
  if (!('code' in error) || typeof error.code !== 'string') return false;
  if (!('syscall' in error) || typeof error.syscall !== 'string') return false;
  if (!('path' in error) || typeof error.path !== 'string') return false;
  const relative = path.relative(root, path.resolve(root, error.path));
  return !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

/**
 * A refusal a later save, or a later try, can clear: it is printed and the loop keeps watching.
 * `ContractsVersionUnsupportedError` is an {@link ApiProblemError}, so a skewed runtime is said
 * on every sync rather than ending `aw dev`.
 */
function isRecoverable(error: unknown, root: string): error is Error {
  return (
    isProjectFileSystemError(error, root) ||
    error instanceof CommandRefusedError ||
    error instanceof UsageError ||
    error instanceof ApiProblemError ||
    error instanceof TransportError ||
    error instanceof ContractViolationError
  );
}

/**
 * Issue #453 (S1-15): keep the project's `agents/` and `surfaces/` in sync with `local`. Syncs
 * once at start, then once per burst of saves. Each sync is `aw push --yes`'s own path with
 * `local` as its only target (ADR-0101), so every write goes through the SDK to the runtime this
 * `aw dev` started. A sync never overlaps another: a save during one runs exactly one more after
 * it.
 *
 * Before any version is saved, each sync creates or registers again the agents' catalog tools
 * whose document, definition or secret changed (C15), with credentials from `aw dev`'s own
 * environment (C10); a tool problem blocks that sync's push. `tools/` and every project-relative
 * document the tools name are watched too.
 *
 * A save of `agent-workspace.yaml` applies its `models` and `connectors` the way start-up does
 * (issue #695); a key only a new runtime can take (see {@link restartLines}) names itself instead.
 *
 * Unlike `aw push`, a sync never writes over an agent edited in the UI (SD11/C21, issue #546): such
 * an agent is printed as an `edited_in_ui` problem and keeps its edit until `aw push --yes`
 * overwrites it, while the project's other agents still sync. The check and the write are not one
 * transaction; ADR-0101 declares that race until V-2.
 */
export function startDevSync(options: DevSyncOptions): DevSync {
  const { client, root, io, signal, origin, defaultEngine, models, onFatal } = options;
  const debounceMs = options.debounceMs ?? DEV_SYNC_DEBOUNCE_MS;
  const printed = new Set(options.announcedSurfaces);
  const printedNotices = new Set<string>();
  // Every name the runtime or a loader child must not see; a `secret()` added later joins it.
  const withheld = new Set(options.forkWithheld);
  const stop = new AbortController();
  const stopped = AbortSignal.any([signal, stop.signal]);

  // The project-relative documents the last load's tools named; watched after each sync.
  let documents: readonly string[] = [];
  const toolStep = async (tools: readonly LoadedTool[], codeTools: readonly LoadedCodeTool[]) => {
    documents = tools.flatMap(({ definition }) =>
      definition.kind === 'openapi' && !definition.spec.startsWith('https:')
        ? [definition.spec]
        : [],
    );
    const applied = await applyProjectTools(
      { client, io, root, project: projectFile.project(), signal: stopped, printedNotices },
      tools,
    );
    const problems = [...applied.problems];
    if (codeTools.length > 0 && options.toolHost !== undefined) {
      problems.push(...(await registerToolHost(client, options.toolHost.url, codeTools, stopped)));
    }
    return problems;
  };

  const report = createSyncReporter({ io, origin, withheld, printed });

  const projectFile = createProjectFileSync(options, { withheld, printedNotices, stopped });

  const syncOnce = async (): Promise<void> => {
    documents = [];
    try {
      await projectFile.apply();
      report(
        await pushProject({
          client,
          root,
          io,
          signal: stopped,
          yes: true,
          onEdited: 'refuse',
          defaultEngine,
          models,
          withheld: [...withheld],
          toolStep,
        }),
      );
    } catch (error) {
      if (stopped.aborted) return;
      if (isRecoverable(error, root)) {
        io.stderr(`sync: ${error.message}\n`);
        return;
      }
      stop.abort();
      onFatal(error instanceof Error ? error : new Error(String(error)));
    } finally {
      watching.watchFiles(documents);
    }
  };

  const scheduler = createSyncScheduler(stopped, debounceMs, syncOnce);
  const watching = watchProject({
    root,
    signal: stopped,
    onChange: scheduler.schedule,
    onProjectFileChange: () => {
      if (options.liveProject === undefined) return;
      projectFile.changed();
      scheduler.schedule();
    },
    onError: (error) => {
      if (stopped.aborted) return;
      stop.abort();
      onFatal(error);
    },
  });
  return scheduler.start();
}

function createSyncScheduler(
  stopped: AbortSignal,
  debounceMs: number,
  syncOnce: () => Promise<void>,
) {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | null = null;
  let dirty = false;

  const loop = async (): Promise<void> => {
    do {
      dirty = false;
      await syncOnce();
    } while (dirty && !stopped.aborted);
    running = null;
  };

  const run = (): void => {
    if (stopped.aborted) return;
    if (running !== null) {
      dirty = true;
      return;
    }
    running = loop();
  };

  const schedule = (): void => {
    if (stopped.aborted) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      run();
    }, debounceMs);
  };

  const closed = new Promise<void>((resolve) => {
    const release = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      void (running ?? Promise.resolve()).then(resolve);
    };
    if (stopped.aborted) release();
    else stopped.addEventListener('abort', release, { once: true });
  });

  return {
    schedule,
    start: (): DevSync => {
      run();
      return { closed, firstSync: running ?? Promise.resolve() };
    },
  };
}
