import type { LaunchContext } from './environment';
import type { Clock } from '../clock';
import type { RandomSource } from '../ids';
import type { RunStatus, RunStore } from './store';
import type { RuntimeLaunchTarget, RuntimeRunResolver } from './launch-target';

interface FinishedRunTelemetry {
  readonly runId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly status: RunStatus;
  readonly durationMs: number;
  /**
   * The run's settled cost at the moment its terminal status is written, or `null` when the store
   * carries no cost for it (the in-memory adapter, or a repository-backed run whose gateway
   * settlement — a separate process — has not landed yet; see issue #134's `accounting_state` for
   * the durable, non-lossy answer to "is this actually zero"). A float here is a deliberate,
   * bounded loss: this value feeds an observability span attribute, never a ledger or an invoice.
   */
  readonly costUsd: number | null;
}

export interface RunnerLauncherOptions {
  /** Legacy fixed target for harnesses. Production resolves the agent's selected profile. */
  readonly baseUrl?: string;
  /** Resolve the selected profile and driver before any request is built or posted. */
  readonly runtime?: RuntimeRunResolver;
  readonly store: RunStore;
  /**
   * Build the body of `POST {base}/run` from one launch.
   *
   * **Required, and with no default**, because the two obvious defaults are both wrong. The one
   * this file used to contain — `{ runId, sessionId, agentId, prompt }`, inlined below the
   * `fetch` call — was written before any runtime existed to send it to, and W1-COMP-01 ran it
   * against the real `apps/runner` for the first time:
   *
   * ```text
   * HTTP/1.1 400 Bad Request
   * {"error":"invalid_run_request","message":"the request body is not a valid RunRequest.",
   *  "issues":[… "path":["cwd"] … "path":["agent"] … "path":["session"] … "path":["scope"] …
   *            "path":["env"] … "code":"unrecognized_keys","keys":["agentId"] …]}
   * ```
   *
   * §14.3's body is `RunRequest` from `@agent-workspace/core`, which is `.strict()` and needs
   * `cwd`, `agent`, `session`, `scope` and `env` — an agent's model, instructions, tool policy
   * and skills, the sandbox root, and the tenant session scope of §25. None of that is in
   * {@link LaunchContext}, and none of it is this module's to decide: it is composed from the
   * agent record and the deployment's values by whoever wires the application together. The
   * other candidate default — importing `RunRequest` here and filling it in with placeholders —
   * would put a fabricated agent configuration on the wire under a schema that validated it.
   *
   * The return is `unknown` — including a promise of one, which is awaited: a composer that has
   * to read the agent row to answer needs to. It is `unknown` rather than `RunRequest` because
   * importing that schema here would put `@agent-workspace/core` back into this module's imports
   * for the sole purpose of describing a value it never inspects; what this module does with the
   * result is `JSON.stringify` it. A throw or a rejection fails the run with a named error and
   * posts nothing.
   */
  readonly buildRunRequest: (context: LaunchContext, runtime?: RuntimeLaunchTarget) => unknown;
  /**
   * Revoke every active gateway token this run holds (issue #235, S-14).
   *
   * Used on exactly one path: {@link buildRunRequest} has already minted the run's token, and the
   * launcher then finds the run is no longer `queued` because an interrupt made it terminal while
   * it was. The interrupt performed its own revocation *before* that token row existed, so this is
   * the call that leaves no live credential behind. Optional, because a composition with no
   * gateway issues no tokens to revoke.
   */
  readonly revokeRunTokens?: (context: LaunchContext) => Promise<void>;
  /**
   * The run's known secret values (its workspace's secrets, per-run tokens), redacted from the
   * server log line of a run whose request could not be prepared (issue #827). Without it, or
   * when it throws, that line withholds the failure's message.
   */
  readonly preparationSecrets?: (context: LaunchContext) => Promise<readonly string[]>;
  /** Injected so a test — and the acceptance harness — can drive a runtime of its own. */
  readonly fetch?: typeof globalThis.fetch;
  /** How long to wait for the runtime to answer `POST /run` before failing the run. */
  readonly connectTimeoutMs?: number;
  /**
   * Hard lifetime for the runner connection. Set below the gateway-token TTL so a subprocess
   * never continues as an apparently-active run after its fixed spawn-time credential expires.
   */
  readonly maxRunDurationMs?: number;
  /**
   * The longest run the host lets a function live (ADR-0120 LC7, Vercel Functions). A profile whose
   * deadline is longer is refused with `run_deadline_exceeds_host` before the runtime is contacted,
   * and a run with no deadline is cut off at this limit like at {@link maxRunDurationMs}.
   */
  readonly hostMaxRunDurationMs?: number;
  /**
   * Keep the launch alive after the request that started it returns (`after()`/`waitUntil` on
   * Vercel, where a detached promise is frozen once the response is sent). Called once,
   * synchronously, with the promise that settles when the whole launch has. Optional: a long-lived
   * server does not need it.
   */
  readonly keepAlive?: (work: Promise<void>) => void;
  /** Durable workspace boundary used before and after every runtime execution. */
  readonly workspaceLifecycle?: RuntimeWorkspaceLifecycle;
  /** Private runner-manager authentication, kept out of the serialized RunRequest. */
  readonly runtimeRequestHeaders?: (
    runtime: RuntimeLaunchTarget | undefined,
  ) => Readonly<Record<string, string>>;
  /**
   * Maximum tar wire bytes accepted from a runtime before durable promotion is refused. Defaults to
   * `RUN_FILES_MAX_ARCHIVE_BYTES`; the payload and member limits are enforced when it is decoded.
   */
  readonly maxOutputArchiveBytes?: number;
  /**
   * Saves what a run left in its read-write storage folders, once it is decided `completed` and
   * before that is stored, so the session stays busy until the save ends. Best effort: a throw is
   * logged and never changes the run's outcome. `collect` streams the tar of one runtime-root-relative
   * path (`null` when absent); `cwd` is the run's directory relative to the runtime root; `signal`
   * aborts at the write-back deadline, at the host's remaining budget, or on an interrupt.
   */
  readonly storageWriteback?: (run: {
    readonly context: LaunchContext;
    readonly body: unknown;
    readonly cwd: string;
    readonly collect: (path: string) => Promise<ReadableStream<Uint8Array> | null>;
    readonly signal: AbortSignal;
  }) => Promise<unknown>;
  /** The write-back's deadline; {@link STORAGE_WRITEBACK_DEADLINE_MS} unless finite and positive. */
  readonly storageWritebackDeadlineMs?: number;
  /** Receives one terminal measurement after the durable run status has been written. */
  readonly onRunFinished?: (measurement: FinishedRunTelemetry) => void;
  /**
   * Name a failure the runtime reported with a contract code (PR #403 review): the public message
   * to store instead of the generic "The runtime reported a run failure.", or `null` to keep that.
   * `reason` is the runtime's raw text and is never stored as given.
   */
  readonly codeRuntimeFailure?: (context: LaunchContext, reason: string) => string | null;
  /**
   * Free the provider sandboxes this run itself started (a provider-hosted sandbox counts against
   * the account's concurrency cap until it ends), never the session's runtime or a sandbox another
   * run of the session started. Awaited, and a failure only logged, before the run's terminal
   * status is written, so the status never overtakes the release.
   */
  readonly releaseRunSandboxes?: (
    context: LaunchContext,
    target: RuntimeLaunchTarget,
  ) => Promise<void>;
  /** Called once when a launch ends, however it ends — after its terminal status is written. */
  readonly onLaunchSettled?: (context: LaunchContext) => void;
  /** Persist the actual Claude session identity only after the runtime reports one. */
  readonly onSessionIdentified?: (context: LaunchContext, sessionId: string) => Promise<void>;
  /**
   * How long, and how often, to re-post `POST {base}/run` while the runtime refuses it with
   * `429 runner_capacity_exhausted` (issue #557). `maxWaitMs` is the total wait budget (default
   * 120 000), `initialDelayMs` the first backoff ceiling (default 250) and `maxDelayMs` the largest
   * single wait (default 5 000). Each value must be finite and positive, or its default applies.
   * The run's credential-bounded lifetime still bounds the whole wait.
   */
  readonly capacityRetry?: {
    readonly maxWaitMs?: number;
    readonly initialDelayMs?: number;
    readonly maxDelayMs?: number;
  };
  /**
   * Where the launcher reads the time: the run's start, its deadlines, the capacity wait and the
   * duration it reports. `systemClock` unless given; for tests (refactoring plan part 09, step 4).
   */
  readonly clock?: Clock;
  /** The capacity wait's backoff jitter. `systemRandom` unless given; for tests. */
  readonly random?: RandomSource;
  /**
   * How often the launch reads its run's status to learn of a stop written by another replica
   * (ADR-0151-FU-1440 D1). `CANCELLATION_WATCH_INTERVAL_MS` unless finite and positive; for tests.
   */
  readonly cancellationWatchIntervalMs?: number;
}

export interface RuntimeWorkspaceLifecycle {
  /**
   * The run's input archive as a stream, or null for an intentionally empty root. Resolving it
   * loads the references and judges the total (`run_files_too_large`); no file is read until the
   * stream is pulled. `onDigest` hears the SHA-256 of each file (by its path under the run's cwd)
   * once its bytes have gone through.
   */
  inputArchive(
    context: LaunchContext,
    onDigest?: (path: string, sha256: string) => void,
  ): Promise<ReadableStream<Uint8Array> | null>;
  /**
   * Stage and promote a collected archive into the workspace's durable object store. Every file
   * lands under `runs/<runId>/outputs/`, never at a bare workspace path; `options.base` is a
   * directory inside the archive that is stripped first (and every entry must sit under it).
   *
   * The one exception is `options.target` (ADR-0163): the run agent's own memory folder,
   * `memory/<agentId>`, and no other path. Its files land there in the `files` area, within the
   * memory bounds (`memory_limit_exceeded`), an unchanged file is not rewritten, and the run leaves
   * one `memory-updated` audit row when it wrote any.
   */
  promoteOutputs(
    context: LaunchContext,
    runtime: RuntimeLaunchTarget,
    archive: Uint8Array,
    options?: { readonly base?: string; readonly target?: string },
  ): Promise<void>;
}
