/**
 * The launcher — what actually produces a run's events.
 *
 * Spec §14.3: every runtime container answers `POST /run` with an SSE stream of SDK events. This
 * module turns that into store writes and a terminal run status, and it is the only place that
 * knows a run has an outside world at all.
 *
 * It reads no environment variables and holds no configuration of its own: the base URL is passed
 * in by whoever composes the application, because `.env.example` and the deployment values of
 * §37 belong to W1-INF-01, and a second place that invents a `RUNNER_URL` is a second source of
 * truth for one value.
 */
import { RUNTIME_CAPACITY_EXHAUSTED } from '@indx-workspace/contracts/runs';
import { z } from 'zod';

import { registerLiveRun, releaseLiveRun, signalRuntimeInterrupt } from './interrupt';
import { relayRunnerStream, type RelayOutcome } from './relay';
import { RUN_STATUS_EVENT } from './sse';
import { atStep, publicPreparationFailure, publicRunFailure } from './failures';
import { DomainError, InfrastructureError } from '../errors';
import type { LaunchContext } from './environment';
import type { RunStatus, RunStore } from './store';
import type { RuntimeLaunchTarget, RuntimeRunResolver } from '../compose/runtime-profile';
import { runStartRefusalError } from '../compose/run-preflight';

export interface FinishedRunTelemetry {
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

/**
 * The platform's own lifecycle event, re-exported for the callers that assert on it.
 *
 * It goes in the event log rather than only on the run record so that a client which reconnects
 * after a failure learns about the failure by *replay*, exactly like every other event. A status
 * that lives only in a row is a status a resumed stream never mentions. It is **not** the only
 * way a client learns a run failed — `sse.ts` writes a `run-failed` control frame before `done`
 * as well — but it is the durable, replayable one.
 *
 * The name is reserved (`sse.ts`, {@link RUN_STATUS_EVENT}) and is written through
 * `store.appendPlatformEvent`, which is the only method that accepts it. A relayed frame carrying
 * this name is rejected at ingestion.
 */
export { RUN_STATUS_EVENT };

function publicRelayFailure(
  outcome: Extract<RelayOutcome, { kind: 'failed' | 'cancelled' }>,
): string {
  return publicRunFailure(new Error(outcome.reason), {
    operation: 'runtime-run-outcome',
    failureKind: 'upstream',
    publicMessage:
      outcome.kind === 'cancelled'
        ? 'The run was interrupted.'
        : 'The runtime reported a run failure.',
  });
}

/** The public message for a runtime outcome: a coded one the composition root names, or the generic one. */
function publicOutcomeMessage(
  options: Pick<RunnerLauncherOptions, 'codeRuntimeFailure'>,
  context: LaunchContext,
  outcome: Extract<RelayOutcome, { kind: 'failed' | 'cancelled' }>,
): string {
  const coded =
    outcome.kind === 'failed' ? options.codeRuntimeFailure?.(context, outcome.reason) : null;
  return coded ?? publicRelayFailure(outcome);
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
  /** Maximum tar accepted from a runtime before durable promotion is refused. */
  readonly maxOutputArchiveBytes?: number;
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
}

export interface RuntimeWorkspaceLifecycle {
  /** Return the authorized tenant-scoped input archive, or null for an intentionally empty root. */
  inputArchive(context: LaunchContext, runtime: RuntimeLaunchTarget): Promise<Uint8Array | null>;
  /** Atomically stage/promote a collected archive into the workspace's durable object store. */
  promoteOutputs(
    context: LaunchContext,
    runtime: RuntimeLaunchTarget,
    archive: Uint8Array,
  ): Promise<void>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_ARCHIVE_BYTES = 128 * 1024 * 1024;
const DEFAULT_CAPACITY_MAX_WAIT_MS = 120_000;
const DEFAULT_CAPACITY_INITIAL_DELAY_MS = 250;
const DEFAULT_CAPACITY_MAX_DELAY_MS = 5_000;
const CAPACITY_REFUSAL_MAX_BYTES = 16 * 1024;
const CAPACITY_EXHAUSTED_FAILURE = `${RUNTIME_CAPACITY_EXHAUSTED}: The runtime is serving its maximum number of concurrent runs; send the message again in a moment.`;

/*
 * Runtime capacity (issue #557). `apps/runner` admits a bounded number of concurrent runs and
 * refuses the next one at admission, before any side effect, with
 * `429 {"error":"runner_capacity_exhausted","message":"… retry when capacity is available"}`.
 * Re-posting the same RunRequest is therefore safe, and the launcher waits for a slot instead of
 * failing a widget conversation outright. Only that exact refusal is waited on: any other 429, a
 * 5xx or a non-SSE answer still goes to `relayRunnerStream` and fails the run as before, so a real
 * error is never hidden behind a retry.
 */
const RunnerCapacityRefusalSchema = z
  .object({ error: z.literal('runner_capacity_exhausted'), message: z.string() })
  .strict();

interface CapacityRetry {
  readonly maxWaitMs: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

interface CapacityRefusal {
  /** The runtime's own `Retry-After`, in milliseconds, or `null` when it sent none usable. */
  readonly retryAfterMs: number | null;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Read a `429` answer and say whether it is the runner's capacity refusal. The body is consumed
 * or cancelled either way, so the connection is released; an oversized, unreadable or
 * non-matching body is not a capacity refusal, and the response then fails the run as before.
 */
async function readCapacityRefusal(response: Response): Promise<CapacityRefusal | null> {
  if (response.status !== 429 || response.body === null) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > CAPACITY_REFUSAL_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const parsed: unknown = JSON.parse(text);
    if (!RunnerCapacityRefusalSchema.safeParse(parsed).success) return null;
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
  const retryAfter = response.headers.get('retry-after')?.trim() ?? '';
  return { retryAfterMs: /^\d+$/u.test(retryAfter) ? Number(retryAfter) * 1_000 : null };
}

/**
 * Exponential backoff with full jitter, never shorter than the runtime's own `Retry-After`, never
 * longer than `maxDelayMs` and never past `remainingMs`. `Retry-After` is only a lower bound: a
 * `Retry-After: 0` (from a proxy, or a future runner) must not remove the backoff and turn every
 * waiting run into a tight re-POST loop against a runtime that is already full.
 */
function capacityDelayMs(
  attempt: number,
  refusal: CapacityRefusal,
  retry: CapacityRetry,
  remainingMs: number,
): number {
  const backoff = Math.random() * Math.min(retry.maxDelayMs, retry.initialDelayMs * 2 ** attempt);
  const delay = Math.min(Math.max(refusal.retryAfterMs ?? 0, backoff), retry.maxDelayMs);
  return Math.max(0, Math.min(delay, remainingMs));
}

/** Wait `ms`, or less if `signal` aborts first. Never rejects: the caller checks why it woke. */
function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function relativeRuntimePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/workspace\/?/u, '');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`persist path ${JSON.stringify(value)} is not workspace-relative`);
  }
  return normalized;
}

async function hydrateRuntime(
  lifecycle: RuntimeWorkspaceLifecycle,
  context: LaunchContext,
  target: RuntimeLaunchTarget,
  base: string,
  doFetch: typeof globalThis.fetch,
  requestHeaders: Readonly<Record<string, string>>,
): Promise<void> {
  const archive = await lifecycle.inputArchive(context, target);
  if (archive === null) return;
  const response = await doFetch(`${base}/files`, {
    method: 'POST',
    headers: { ...requestHeaders, 'Content-Type': 'application/x-tar' },
    // Copy into a concrete ArrayBuffer: Uint8Array's generic backing store may be a
    // SharedArrayBuffer, which Fetch deliberately does not accept as BodyInit.
    body: Uint8Array.from(archive).buffer,
  });
  if (!response.ok) {
    throw new InfrastructureError({
      component: 'runtime',
      operation: 'hydrate-workspace',
      failureKind: 'upstream',
      cause: await runtimeHttpFailure(response),
    });
  }
}

/**
 * The runner's own error body is the only place the real reason lives; it stays in the server log.
 * Only the first chunk is read, so an arbitrarily large error page is never buffered.
 */
async function runtimeHttpFailure(response: Response): Promise<Error> {
  const reader = response.body?.getReader();
  const first = reader === undefined ? undefined : await reader.read().catch(() => undefined);
  await reader?.cancel().catch(() => undefined);
  const body =
    first?.value === undefined ? '' : new TextDecoder().decode(first.value.subarray(0, 500));
  return new Error(
    `runtime returned HTTP ${String(response.status)}${body === '' ? '' : `: ${body}`}`,
  );
}

async function collectRuntimeOutputs(
  lifecycle: RuntimeWorkspaceLifecycle | undefined,
  context: LaunchContext,
  target: RuntimeLaunchTarget | undefined,
  base: string,
  doFetch: typeof globalThis.fetch,
  maxBytes: number,
  requestHeaders: Readonly<Record<string, string>>,
): Promise<string | null> {
  if (lifecycle === undefined || target === undefined || target.persistPaths?.length === 0) {
    return null;
  }
  if (target.persistPaths === undefined) return null;
  try {
    const query = new URLSearchParams();
    for (const path of target.persistPaths) query.append('path', relativeRuntimePath(path));
    const response = await doFetch(`${base}/files?${query.toString()}`, {
      method: 'GET',
      headers: { ...requestHeaders, Accept: 'application/x-tar' },
    });
    if (!response.ok) {
      throw new InfrastructureError({
        component: 'runtime',
        operation: 'collect-workspace-outputs',
        failureKind: 'upstream',
        cause: await runtimeHttpFailure(response),
      });
    }
    const declared = response.headers.get('content-length');
    if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
      throw new Error(`runtime output archive exceeds ${String(maxBytes)} bytes`);
    }
    const archive = new Uint8Array(await response.arrayBuffer());
    if (archive.byteLength > maxBytes) {
      throw new Error(`runtime output archive exceeds ${String(maxBytes)} bytes`);
    }
    await lifecycle.promoteOutputs(context, target, archive);
    return null;
  } catch (cause) {
    return publicRunFailure(cause, {
      operation: 'collect-workspace-outputs',
      failureKind: 'upstream',
      publicMessage: 'Run output could not be saved.',
    });
  }
}

/** Write a terminal status as both an event and a record update, in that order. */
async function conclude(
  store: RunStore,
  context: LaunchContext,
  status: RunStatus,
  error: string | null,
  startedAtMs: number,
  options: RunnerLauncherOptions,
  target: RuntimeLaunchTarget | undefined,
): Promise<void> {
  const runId = context.run.id;
  await releaseRunSandboxesBestEffort(options, context, target);
  await store.finish(runId, status, error, true);
  // Read back after `finish`: whatever the gateway's (separately-processed) usage settlement has
  // landed by now is what this terminal measurement reports. `Number.isFinite` is the positive
  // assertion — an unparsable or non-numeric stored value reports `null` rather than `NaN`.
  const settled = await store.get(runId);
  const settledCost = settled?.costUsd === undefined ? null : Number(settled.costUsd);
  options.onRunFinished?.({
    runId,
    workspaceId: context.principal.workspaceId,
    agentId: context.agent.id,
    status,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    costUsd: settledCost !== null && Number.isFinite(settledCost) ? settledCost : null,
  });
}

/** Release the run's provider resources; a failure goes to server diagnostics, never to the caller. */
async function releaseRunSandboxesBestEffort(
  options: Pick<RunnerLauncherOptions, 'releaseRunSandboxes'>,
  context: LaunchContext,
  target: RuntimeLaunchTarget | undefined,
): Promise<void> {
  if (target === undefined) return;
  try {
    await options.releaseRunSandboxes?.(context, target);
  } catch (cause) {
    publicRunFailure(cause, {
      operation: 'release-run-sandboxes',
      failureKind: 'upstream',
      publicMessage: 'The run sandboxes could not be released.',
    });
  }
}

/** Revoke the run's gateway tokens; a failure goes to server diagnostics, never to the caller. */
async function revokeRunTokensBestEffort(
  options: Pick<RunnerLauncherOptions, 'revokeRunTokens'>,
  context: LaunchContext,
): Promise<void> {
  try {
    await options.revokeRunTokens?.(context);
  } catch (cause) {
    publicRunFailure(cause, {
      operation: 'revoke-run-tokens',
      failureKind: 'upstream',
      publicMessage: 'The run tokens could not be revoked.',
    });
  }
}

interface RunPostAttempts {
  readonly doFetch: typeof globalThis.fetch;
  readonly url: string;
  readonly init: Omit<RequestInit, 'signal'>;
  readonly connectTimeoutMs: number;
  readonly lifetime: AbortSignal;
  readonly lifetimeExpired: () => boolean;
  readonly lifetimeFailure: string;
  readonly retry: CapacityRetry;
  readonly stillRunning: () => Promise<boolean>;
  readonly revokeRunTokens: () => Promise<void>;
}

type RunPostResult =
  | { readonly kind: 'response'; readonly response: Response }
  | { readonly kind: 'stopped'; readonly status: 'failed' | 'cancelled'; readonly error: string };

/**
 * `POST {base}/run`, waiting for runtime capacity (issue #557).
 *
 * One POST per turn, and only the runner's capacity refusal turns again: every other answer is
 * returned for `relayRunnerStream` to judge. Each attempt has its own connect deadline, which
 * covers the headers only (see the launcher's comment on `AbortSignal.timeout`). The run stays
 * `running` while it waits, the credential-bounded lifetime keeps running across the whole wait,
 * and an interrupt that makes the run terminal ends the wait without another POST.
 */
async function postRunAwaitingCapacity(attempts: RunPostAttempts): Promise<RunPostResult> {
  const deadline = Date.now() + attempts.retry.maxWaitMs;
  for (let attempt = 0; ; attempt += 1) {
    const connect = new AbortController();
    const timer = setTimeout(
      () =>
        connect.abort(
          new Error(`the runtime did not respond within ${String(attempts.connectTimeoutMs)}ms`),
        ),
      attempts.connectTimeoutMs,
    );
    (timer as { unref?: () => void }).unref?.();
    let response: Response;
    let refusal: CapacityRefusal | null;
    try {
      response = await attempts.doFetch(attempts.url, {
        ...attempts.init,
        signal: AbortSignal.any([connect.signal, attempts.lifetime]),
      });
      refusal = await readCapacityRefusal(response);
    } catch (cause) {
      const error = attempts.lifetimeExpired()
        ? attempts.lifetimeFailure
        : publicRunFailure(cause, {
            operation: 'start-runtime-run',
            failureKind: 'upstream',
            publicMessage: 'The runtime could not be reached.',
          });
      return { kind: 'stopped', status: 'failed', error };
    } finally {
      clearTimeout(timer);
    }
    if (refusal === null) return { kind: 'response', response };

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      const error = publicRunFailure(
        new Error(
          `the runtime stayed at its concurrent-run capacity for ${String(attempts.retry.maxWaitMs)}ms over ${String(attempt + 1)} attempts`,
        ),
        {
          operation: 'await-runtime-capacity',
          failureKind: 'upstream',
          publicMessage: CAPACITY_EXHAUSTED_FAILURE,
        },
      );
      return { kind: 'stopped', status: 'failed', error };
    }
    await waitUnlessAborted(
      capacityDelayMs(attempt, refusal, attempts.retry, remainingMs),
      attempts.lifetime,
    );
    if (attempts.lifetimeExpired()) {
      return { kind: 'stopped', status: 'failed', error: attempts.lifetimeFailure };
    }
    let stillRunning: boolean;
    try {
      stillRunning = await attempts.stillRunning();
    } catch (cause) {
      // The store could not say whether an interrupt landed during the wait. Posting anyway could
      // hand a cancelled run's credential to the runtime, and letting the error escape would skip
      // every terminal write and leave the run `running` for good. So post nothing more, revoke
      // the run's tokens, and fail the run through the caller's normal `conclude`.
      await attempts.revokeRunTokens();
      const error = publicRunFailure(cause, {
        operation: 'read-run-status',
        publicMessage: 'The run status could not be read while it waited for runtime capacity.',
      });
      return { kind: 'stopped', status: 'failed', error };
    }
    if (!stillRunning) {
      // An interrupt landed during the wait: post nothing more, and leave no live credential
      // behind, as for an interrupt that lands while the run is still queued. `finish` is
      // first-call-wins, so the stored status and error stay the interrupt's.
      await attempts.revokeRunTokens();
      return {
        kind: 'stopped',
        status: 'cancelled',
        error: INTERRUPTED_DURING_CAPACITY_WAIT,
      };
    }
  }
}

/**
 * The stored error of a run interrupted while it waited for runtime capacity. It is a named
 * constant, not an inline string on the error field, because it is a run record's error text and
 * not an HTTP body: the envelope sweep (`error-envelope-inventory.test.ts`) refuses the bare-code
 * body shape in server sources.
 */
const INTERRUPTED_DURING_CAPACITY_WAIT =
  'the run was interrupted while it waited for runtime capacity';

/**
 * The secret values a preparation failure's log line is redacted of, or `null` when they are
 * unknown (no source, or it threw), so the line withholds the message. A coded refusal logs
 * nothing, so it reads none.
 */
async function preparationSecretsOf(
  options: RunnerLauncherOptions,
  context: LaunchContext,
  cause: unknown,
): Promise<readonly string[] | null> {
  if (cause instanceof DomainError) return [];
  if (options.preparationSecrets === undefined) return null;
  return options.preparationSecrets(context).catch(() => null);
}

/**
 * Fail a launch whose request could not be prepared, with the public `detail`. An interrupt may
 * have ended the run while it was queued, after `buildRunRequest` minted its gateway token; then
 * `finish` is a no-op that revokes nothing, so the launch is abandoned like an interrupted one.
 */
async function concludePreparationFailure(
  store: RunStore,
  options: RunnerLauncherOptions,
  context: LaunchContext,
  detail: string,
  startedAtMs: number,
  target: RuntimeLaunchTarget | undefined,
): Promise<void> {
  if (!(await store.markRunning(context.run.id))) {
    await abandonInterruptedLaunch(store, options, context, startedAtMs, target);
    return;
  }
  await store.appendPlatformEvent(context.run.id, {
    type: RUN_STATUS_EVENT,
    data: { status: 'running', error: null },
  });
  await conclude(store, context, 'failed', detail, startedAtMs, options, target);
}

/**
 * Finalise a launch that must not reach the runtime, because the run went terminal while it was
 * still `queued` (issue #235, S-14).
 *
 * Revoking is what this path exists for: the interrupt's own `revokeForRun` ran before
 * {@link RunnerLauncherOptions.buildRunRequest} minted the run's gateway token, so without this
 * call the cancelled run leaves a live credential behind. A revocation that itself fails has
 * nowhere left to be written — the run is already terminal — so it goes to server diagnostics
 * rather than being lost, and finalisation still happens.
 */
async function abandonInterruptedLaunch(
  store: RunStore,
  options: RunnerLauncherOptions,
  context: LaunchContext,
  startedAtMs: number,
  target: RuntimeLaunchTarget | undefined,
): Promise<void> {
  await revokeRunTokensBestEffort(options, context);
  // `finish` is first-call-wins, so the stored status and error stay the interrupt's; what this
  // adds is the terminal telemetry measurement every other outcome of a launch also emits.
  await conclude(
    store,
    context,
    'cancelled',
    'the run was interrupted before it reached the runtime',
    startedAtMs,
    options,
    target,
  );
}

/** Refuse, by name, a profile deadline that outlives the host's function limit (ADR-0120 LC7). */
function assertDeadlineFitsHost(
  timeoutSeconds: number | undefined,
  hostMaxMs: number | null,
): void {
  if (hostMaxMs === null || timeoutSeconds === undefined || timeoutSeconds * 1_000 <= hostMaxMs) {
    return;
  }
  throw runStartRefusalError({
    code: 'run_deadline_exceeds_host',
    message:
      `the runtime profile's deadline of ${String(timeoutSeconds)}s is longer than the ` +
      `${String(Math.floor(hostMaxMs / 1_000))}s a run may last on this host. ` +
      'Shorten the timeout of the runtime profile.',
  });
}

/**
 * What is left of the host's function limit once preparation is done, or `null` on a host with
 * none. The host's clock started with the request: preparation (sandbox creation, workspace
 * hydration) already spent part of it. A budget with nothing left is refused like a deadline the
 * host cannot honour, before the runtime is contacted.
 */
function hostBudgetLeft(hostMaxMs: number | null, startedAtMs: number): number | null {
  if (hostMaxMs === null) return null;
  const remainingMs = hostMaxMs - (Date.now() - startedAtMs);
  if (remainingMs > 0) return remainingMs;
  throw runStartRefusalError({
    code: 'run_deadline_exceeds_host',
    message:
      `preparing the run used the whole ${String(Math.floor(hostMaxMs / 1_000))}s a run may ` +
      'last on this host, so it was not started.',
  });
}

/** Name what bounds the run's lifetime, so a failure says whether the host limit ended it. */
function describeLifetime(maxRunDurationMs: number | null, hostRemainingMs: number | null): string {
  return maxRunDurationMs !== null && maxRunDurationMs === hostRemainingMs
    ? `host-limited lifetime of ${String(maxRunDurationMs)}ms (the host's function limit ended it)`
    : `credential-bounded lifetime of ${String(maxRunDurationMs)}ms`;
}

/**
 * Build a `launch` for {@link import('./environment.js').RunApiEnvironment}.
 *
 * Fire-and-forget by contract: it returns as soon as the run is queued, and every outcome —
 * including "the runtime never answered" — is written to the store rather than to the HTTP
 * response that started the run.
 */
export function createRunnerLauncher(options: RunnerLauncherOptions): (c: LaunchContext) => void {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs =
    typeof options.connectTimeoutMs === 'number' && options.connectTimeoutMs > 0
      ? options.connectTimeoutMs
      : DEFAULT_CONNECT_TIMEOUT_MS;
  const store = options.store;
  const configuredMaxRunDurationMs =
    typeof options.maxRunDurationMs === 'number' &&
    Number.isFinite(options.maxRunDurationMs) &&
    options.maxRunDurationMs > 0
      ? options.maxRunDurationMs
      : null;
  const hostMaxRunDurationMs =
    typeof options.hostMaxRunDurationMs === 'number' &&
    Number.isFinite(options.hostMaxRunDurationMs) &&
    options.hostMaxRunDurationMs > 0
      ? options.hostMaxRunDurationMs
      : null;
  const maxOutputArchiveBytes =
    typeof options.maxOutputArchiveBytes === 'number' &&
    Number.isSafeInteger(options.maxOutputArchiveBytes) &&
    options.maxOutputArchiveBytes > 0
      ? options.maxOutputArchiveBytes
      : DEFAULT_MAX_OUTPUT_ARCHIVE_BYTES;
  const capacityRetry: CapacityRetry = {
    maxWaitMs: positiveOr(options.capacityRetry?.maxWaitMs, DEFAULT_CAPACITY_MAX_WAIT_MS),
    initialDelayMs: positiveOr(
      options.capacityRetry?.initialDelayMs,
      DEFAULT_CAPACITY_INITIAL_DELAY_MS,
    ),
    maxDelayMs: positiveOr(options.capacityRetry?.maxDelayMs, DEFAULT_CAPACITY_MAX_DELAY_MS),
  };

  return (context: LaunchContext): void => {
    const work = (async (): Promise<void> => {
      const runId = context.run.id;
      const startedAtMs = Date.now();

      // Compile before anything is written or sent. A body that cannot be built is a run that
      // cannot start, and it is reported as a failed run rather than as an empty stream — the
      // caller already has a 202 and a stream URL, so the only place left to say so is the store.
      let body: unknown;
      let target: RuntimeLaunchTarget | undefined;
      let base: string;
      let hydrating = false;
      let runtimeHeaders: Readonly<Record<string, string>> = {};
      let hostRemainingMs: number | null;
      try {
        const runtime = options.runtime;
        target =
          runtime === undefined
            ? undefined
            : await atStep('runtime_profile', () => runtime.resolve(context));
        assertDeadlineFitsHost(target?.timeoutSeconds, hostMaxRunDurationMs);
        const selectedUrl = target?.runnerUrl ?? options.baseUrl;
        if (selectedUrl === undefined || selectedUrl.trim().length === 0) {
          throw new Error('no runtime launch target was selected');
        }
        base = selectedUrl.replace(/\/+$/, '');
        runtimeHeaders = options.runtimeRequestHeaders?.(target) ?? {};
        body = await atStep('compose', () => options.buildRunRequest(context, target));
        // The in-process runner already materialises `resources.files` into the run's cwd, and
        // its `/files` endpoint is not session-scoped, so a `local` target is never hydrated.
        if (
          options.workspaceLifecycle !== undefined &&
          target !== undefined &&
          target.driver !== 'local'
        ) {
          hydrating = true;
          await hydrateRuntime(
            options.workspaceLifecycle,
            context,
            target,
            base,
            doFetch,
            runtimeHeaders,
          );
        }
        hostRemainingMs = hostBudgetLeft(hostMaxRunDurationMs, startedAtMs);
      } catch (cause) {
        const detail = hydrating
          ? publicRunFailure(cause, {
              operation: 'hydrate-workspace',
              publicMessage: 'The workspace could not be prepared.',
              failureKind: 'upstream',
            })
          : publicPreparationFailure(cause, await preparationSecretsOf(options, context, cause));
        await concludePreparationFailure(store, options, context, detail, startedAtMs, target);
        return;
      }

      const profileDurationMs =
        target?.timeoutSeconds === undefined ? null : target.timeoutSeconds * 1_000;
      const bounds = [configuredMaxRunDurationMs, hostRemainingMs, profileDurationMs].filter(
        (bound): bound is number => bound !== null,
      );
      const maxRunDurationMs = bounds.length === 0 ? null : Math.min(...bounds);
      const lifetimeLabel = describeLifetime(maxRunDurationMs, hostRemainingMs);

      // `base` is known from here on: register this process as the one holding the run's runtime
      // connection, for `POST /api/runs/:id/interrupt` (issue #235, S-14) to find through
      // `interrupt.ts`'s registry. Released in `finally` below, whatever the run's outcome —
      // including a failure that never reaches the runtime at all.
      registerLiveRun(runId, { base, headers: runtimeHeaders });
      try {
        // `markRunning` moves a run only out of `queued`, and reports whether *this* call is what
        // moved it. `false` here means something else already took the run out of `queued`, and on
        // this path that something is an interrupt: `POST /api/runs/:id/interrupt` accepts a run
        // that is still queued, writes its terminal `cancelled` status and revokes its tokens — of
        // which there were none, because `buildRunRequest` above is where the run's gateway token
        // is minted. Posting `/run` now would hand the runtime a brand-new, live credential for a run
        // whose caller has already been told it was cancelled, which is exactly the invariant the
        // interrupt's ordering exists to buy ("a caller never sees success for a run whose
        // credential is still live", docs/adr/SDK-03-RUN-235-*.md). So nothing is sent, the
        // credential this launch minted is revoked, and the run is finalised through the same
        // `conclude` as every other outcome. `releaseLiveRun` still runs in the `finally` below.
        if (!(await store.markRunning(runId))) {
          await abandonInterruptedLaunch(store, options, context, startedAtMs, target);
          return;
        }
        await store.appendPlatformEvent(runId, {
          type: RUN_STATUS_EVENT,
          data: { status: 'running', error: null },
        });

        // The timeout covers the CONNECT, and is cancelled the moment response headers arrive.
        // `AbortSignal.timeout(ms)` was here first and was wrong: its signal stays attached to the
        // response body, so it aborted the run's stream `ms` after it started, no matter how well
        // it was going. The acceptance run caught it as a ten-minute stream that failed at exactly
        // thirty seconds. A connect deadline must not become a run deadline — R-13 finding 8 is
        // the whole reason a run outlives any one connection.
        const lifetime = new AbortController();
        let lifetimeExpired = false;
        const lifetimeTimer =
          maxRunDurationMs === null
            ? null
            : setTimeout(() => {
                lifetimeExpired = true;
                lifetime.abort(new Error(`the run reached its ${lifetimeLabel}`));
                // Best effort cleanup of the child. The abort above is the security boundary: it
                // makes the control-plane run terminal and atomically revokes its registered token
                // even if this interrupt request cannot reach the runtime.
                void signalRuntimeInterrupt(base, runId, runtimeHeaders, doFetch);
              }, maxRunDurationMs);
        (lifetimeTimer as { unref?: () => void } | null)?.unref?.();
        const lifetimeFailure = `The run exceeded its ${lifetimeLabel}.`;

        const posted = await postRunAwaitingCapacity({
          doFetch,
          url: `${base}/run`,
          init: {
            method: 'POST',
            headers: {
              ...runtimeHeaders,
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
            },
            body: JSON.stringify(body),
          },
          connectTimeoutMs: timeoutMs,
          lifetime: lifetime.signal,
          lifetimeExpired: () => lifetimeExpired,
          lifetimeFailure,
          retry: capacityRetry,
          stillRunning: async () => (await store.get(runId))?.status === 'running',
          revokeRunTokens: () => revokeRunTokensBestEffort(options, context),
        });
        if (posted.kind === 'stopped') {
          // Nothing was relayed, so there are no outputs to collect.
          if (lifetimeTimer !== null) clearTimeout(lifetimeTimer);
          await conclude(store, context, posted.status, posted.error, startedAtMs, options, target);
          return;
        }
        const response = posted.response;

        const outcome = await relayRunnerStream(runId, response, store, async (sessionId) => {
          await options.onSessionIdentified?.(context, sessionId);
        });
        if (lifetimeTimer !== null) clearTimeout(lifetimeTimer);
        const persistenceFailure = await collectRuntimeOutputs(
          options.workspaceLifecycle,
          context,
          target,
          base,
          doFetch,
          maxOutputArchiveBytes,
          runtimeHeaders,
        );
        if (lifetimeExpired) {
          const reason = lifetimeFailure;
          await conclude(
            store,
            context,
            'failed',
            persistenceFailure === null ? reason : `${reason} ${persistenceFailure}`,
            startedAtMs,
            options,
            target,
          );
          return;
        }
        const publicOutcomeFailure =
          outcome.kind === 'completed' ? null : publicOutcomeMessage(options, context, outcome);
        if (outcome.kind === 'completed' && persistenceFailure === null) {
          await conclude(store, context, 'completed', null, startedAtMs, options, target);
        } else if (outcome.kind === 'cancelled') {
          // Issue #235: the runner itself reported the interrupt — either this replica's own
          // `POST /api/runs/:id/interrupt` reached it, or an operator/credential-lifetime signal
          // did. `cancelled`, not `failed`: a user or the platform stopping a run on purpose is not
          // an error (`packages/core/src/db/schema/runs.ts`'s own comment on the status). `finish`
          // is first-call-wins, so this is a no-op when the interrupt route already concluded it.
          const reason =
            persistenceFailure === null
              ? publicOutcomeFailure
              : `${publicOutcomeFailure} ${persistenceFailure}`;
          await conclude(store, context, 'cancelled', reason, startedAtMs, options, target);
        } else {
          const reason =
            outcome.kind === 'completed'
              ? String(persistenceFailure)
              : persistenceFailure === null
                ? publicOutcomeFailure
                : `${publicOutcomeFailure} ${persistenceFailure}`;
          await conclude(store, context, 'failed', reason, startedAtMs, options, target);
        }
      } finally {
        releaseLiveRun(runId);
      }
    })()
      .catch((cause: unknown) => {
        // The store may itself be unavailable, so there is no reliable place left to persist this.
        // Keep the cause in server diagnostics instead of silently losing the failure.
        publicRunFailure(cause, {
          operation: 'finalize-run',
          publicMessage: 'The run could not be finalized.',
        });
      })
      .finally(() => {
        options.onLaunchSettled?.(context);
      });
    options.keepAlive?.(work);
  };
}
