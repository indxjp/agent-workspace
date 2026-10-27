import { setTimeout as sleep } from 'node:timers/promises';

import type {
  RuntimeDriverId,
  RuntimeHandle,
  RuntimeRunSpec,
} from '@agent-workspace/runtime/driver';
import type { ToolSandboxRequest } from '@indx-workspace/contracts/agent-versions';

import type { LaunchContext } from '../runs/environment';

export type RuntimeAllocation = Readonly<{
  handle: RuntimeHandle;
  runnerUrl: string;
  /** Where the session's tool sandbox listens; present only when `allocate` asked for one. */
  toolSandboxOrigin?: string;
}>;

export type RuntimeManagerClient = Readonly<{
  allocate(
    context: LaunchContext,
    spec: RuntimeRunSpec,
    toolSandbox?: ToolSandboxRequest,
    /** The provider key for this call only (ADR-0120 LC6); sent in a header, never in the body. */
    providerCredential?: string,
  ): Promise<RuntimeAllocation>;
  /** Starts (or reuses) a project endpoint client's tool sandbox, with no agent runtime. */
  openToolSandbox(
    input: Readonly<{ workspaceId: string; clientId: string; toolSandbox: ToolSandboxRequest }>,
    /** The provider key for this call only (ADR-0120 LC6); sent in a header, never in the body. */
    providerCredential?: string,
  ): Promise<string>;
  /** Closes the sandbox `openToolSandbox` started for the client; an unknown one is not an error. */
  closeToolSandbox(
    workspaceId: string,
    clientId: string,
    /** The provider key for this call only (ADR-0120 LC6); sent in a header, never in the body. */
    providerCredential?: string,
  ): Promise<void>;
  /**
   * Removes the tool sandboxes run `runId` started, never the session's runtime or a sandbox the
   * run only reused (issue #832); a run that started none is not an error.
   */
  releaseRunToolSandboxes(
    workspaceId: string,
    runId: string,
    /** The provider key for this call only (ADR-0120 LC6); sent in a header, never in the body. */
    providerCredential?: string,
  ): Promise<void>;
  verify(
    config: Readonly<{ sessionId: string; workspacePath: string; engine: string }>,
    driver: RuntimeDriverId,
    /** The provider key for this call only (ADR-0120 LC6); sent in a header, never in the body. */
    providerCredential?: string,
  ): Promise<Readonly<{ fingerprint: string; verifiedAt: string; expiresAt: string }>>;
  destroy(
    handleId: string,
    /** The provider key for this call only (ADR-0120 LC6); sent in a header, never in the body. */
    providerCredential?: string,
  ): Promise<void>;
  authorizationHeaders(): Readonly<Record<string, string>>;
}>;

/** A manager answer that may echo the provider key must not carry it into a run's error. */
function redacted(text: string, secret: string | undefined): string {
  return secret === undefined || secret === '' ? text : text.split(secret).join('[redacted]');
}

const SAFE_TOKEN = /^[a-z][a-z0-9_-]{0,63}$/u;
const TOOL_SANDBOX_UNAVAILABLE = 'tool_sandbox_unavailable';

/**
 * A manager call that failed. `status` and the two tokens are the only parts of the answer safe to
 * show a caller: `code` is the manager's typed error code (or a fixed-vocabulary platform token for
 * an answer that is not the manager's JSON) and `step` the Worker hop that threw (`forward`,
 * `container-binding`, ...); anything else in the body stays in `message`, which is for the
 * redacted server log. Status `0` means no answer arrived (`timeout` / `unreachable`); a 2xx
 * answer the client cannot use keeps its status and the code `invalid_answer`.
 *
 * `detail` is the manager's own `message`, kept only for `tool_sandbox_unavailable`: that code's
 * messages are fixed strings the runner writes (or a sanitized provider reason). It is not part of
 * `safeCause`; the caller redacts it of the run's secrets before showing it.
 */
export class RuntimeManagerError extends Error {
  override readonly name = 'RuntimeManagerError';
  readonly detail: string | undefined;

  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly step: string | undefined,
    options?: ErrorOptions & { detail?: string },
  ) {
    super(message, options);
    this.detail = options?.detail;
  }

  /** Which hop failed, without any body text. */
  get safeCause(): string {
    const parts = [
      this.status === 0
        ? 'runner manager did not answer'
        : `runner manager answered HTTP ${String(this.status)}`,
    ];
    if (this.code !== undefined) parts.push(this.code);
    if (this.step !== undefined) parts.push(`at ${this.step}`);
    return parts.join(' ');
  }
}

function safeToken(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : undefined;
}

const PLATFORM_ERROR_HEADER = /^[A-Z][A-Z0-9_]{2,63}$/u;
const PLATFORM_ERROR_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/u;
const PLATFORM_BODY_WINDOW = 4096;

/**
 * Names an answer that is not the manager's JSON from a fixed vocabulary only: the platform's own
 * `x-vercel-error` code (`FUNCTION_INVOCATION_FAILED`), else an `UPPER_SNAKE` token its error page
 * carries, else the kind of body. Never body text.
 */
function nonJsonCode(response: Response, text: string): string {
  const header = response.headers.get('x-vercel-error')?.trim() ?? '';
  const token = PLATFORM_ERROR_HEADER.test(header)
    ? header
    : PLATFORM_ERROR_TOKEN.exec(text.slice(0, PLATFORM_BODY_WINDOW))?.[0];
  if (token !== undefined) return token.toLowerCase();
  if (text.trim() === '') return 'non_json_empty';
  const html =
    (response.headers.get('content-type') ?? '').includes('html') ||
    text.trimStart().startsWith('<');
  return html ? 'non_json_html' : 'non_json_text';
}

/** The typed code and Worker step in a manager answer; the Worker's fixed 503 text is `manager_not_ready`. */
async function managerFailure(
  what: string,
  response: Response,
  providerCredential: string | undefined,
): Promise<RuntimeManagerError> {
  const { status } = response;
  const text = await response.text().catch(() => '');
  let code: string | undefined;
  let step: string | undefined;
  let detail: string | undefined;
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown } | null;
    const error = body?.error;
    if (typeof error === 'object' && error !== null) {
      code = safeToken((error as { code?: unknown }).code);
      step = safeToken((error as { step?: unknown }).step);
    } else code = safeToken(error);
    if (code === TOOL_SANDBOX_UNAVAILABLE && typeof body?.message === 'string') {
      detail = redacted(body.message, providerCredential);
    }
  } catch {
    code =
      status === 503 && text.startsWith('The runner manager ')
        ? 'manager_not_ready'
        : nonJsonCode(response, text);
  }
  return new RuntimeManagerError(
    `runtime manager ${what} failed with ${String(status)}: ${redacted(text, providerCredential)}`,
    status,
    code,
    step,
    detail === undefined ? undefined : { detail },
  );
}

/** A call that produced no answer: a timeout, or a connection the platform refused or dropped. */
async function send(
  what: string,
  providerCredential: string | undefined,
  request: Promise<Response>,
): Promise<Response> {
  try {
    return await request;
  } catch (cause) {
    const timedOut =
      cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
    const reason = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    throw new RuntimeManagerError(
      `runtime manager ${what} did not answer: ${redacted(reason, providerCredential)}`,
      0,
      timedOut ? 'timeout' : 'unreachable',
      undefined,
      { cause },
    );
  }
}

function invalidAnswer(what: string, status: number, problem: string): RuntimeManagerError {
  return new RuntimeManagerError(
    `runtime manager ${what} ${problem}`,
    status,
    'invalid_answer',
    undefined,
  );
}

/** A 2xx answer the client cannot use is the manager's fault, so it is typed like any other hop failure. */
async function jsonAnswer(what: string, response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw invalidAnswer(what, response.status, 'answered something that is not JSON');
  }
}

function credentialHeader(providerCredential: string | undefined): Record<string, string> {
  return providerCredential === undefined ? {} : { 'X-Provider-Credential': providerCredential };
}

/**
 * How long `verify` keeps asking while the manager Worker answers `manager_not_ready`: its container
 * is still starting. Short, so a manager that never starts still fails inside setup's runtime-test
 * deadline; the delay doubles from `initialDelayMs` up to `MAX_NOT_READY_DELAY_MS`.
 */
export type NotReadyRetry = Readonly<{ windowMs: number; initialDelayMs: number }>;

const DEFAULT_NOT_READY_RETRY: NotReadyRetry = { windowMs: 30_000, initialDelayMs: 1_000 };
const MAX_NOT_READY_DELAY_MS = 8_000;

/** Only the Worker's own 503 is retried: it answers before forwarding, so the manager never saw the call. */
function isManagerNotReady(error: unknown): boolean {
  return (
    error instanceof RuntimeManagerError &&
    error.status === 503 &&
    error.code === 'manager_not_ready'
  );
}

/** Private client for the runner-owned Docker lifecycle API. */
export function createRuntimeManagerClient(
  baseUrl: string,
  token: string,
  doFetch: typeof globalThis.fetch = globalThis.fetch,
  options: Readonly<{
    verificationNetworkPolicy?: RuntimeRunSpec['networkPolicy'];
    notReadyRetry?: NotReadyRetry;
  }> = {},
): RuntimeManagerClient {
  if (baseUrl.trim().length === 0) throw new Error('runtime manager URL is required');
  if (token.length < 32)
    throw new Error('runtime manager token must contain at least 32 characters');
  const base = baseUrl.replace(/\/+$/u, '');
  const headers = () => ({ Authorization: `Bearer ${token}` });
  // `none` preserves the existing verification contract. Managed runtimes whose network mode is
  // fixed at pool creation (notably ACA dynamic sessions) can verify an egress-enabled pool with
  // `open`; the manager/driver still performs the authoritative enforcement check.
  const verificationNetworkPolicy = options.verificationNetworkPolicy ?? 'none';
  const notReadyRetry = options.notReadyRetry ?? DEFAULT_NOT_READY_RETRY;
  const verifyOnce: RuntimeManagerClient['verify'] = async (config, driver, providerCredential) => {
    const request = doFetch(`${base}/verify`, {
      method: 'POST',
      headers: {
        ...headers(),
        'Content-Type': 'application/json',
        ...credentialHeader(providerCredential),
      },
      body: JSON.stringify({
        workspaceId: 'runtime-verification',
        sessionId: config.sessionId,
        // A verification probe is not a run and has no agent, so it names the engine it is
        // probing explicitly. `Test Runtime` answers "can this deployment start a sandbox for
        // this engine", and a probe that did not say which engine would verify whichever image
        // the driver happened to pick — which since ENG-07 is no longer a well-defined thing.
        engine: config.engine,
        runSpec: {
          runtimeProfileId: `${driver}-verification`,
          driver,
          networkPolicy: verificationNetworkPolicy,
          filesystem: 'read-write',
          // ACA timed sessions expose pool idle expiry, not a per-session hard timeout. The
          // manager's own verification deadline and guaranteed destroy bound this probe.
          ...(driver === 'aca-sessions' ? {} : { timeoutSeconds: 30 }),
        } satisfies RuntimeRunSpec,
      }),
    });
    const response = await send('verification', providerCredential, request);
    if (!response.ok) throw await managerFailure('verification', response, providerCredential);
    const answer = await jsonAnswer('verification', response);
    const value = (typeof answer === 'object' && answer !== null ? answer : {}) as Record<
      string,
      unknown
    >;
    for (const field of ['fingerprint', 'verifiedAt', 'expiresAt'] as const) {
      if (typeof value[field] !== 'string' || value[field].length === 0) {
        throw invalidAnswer('verification', response.status, `omitted ${field}`);
      }
    }
    return {
      fingerprint: value['fingerprint'] as string,
      verifiedAt: value['verifiedAt'] as string,
      expiresAt: value['expiresAt'] as string,
    };
  };
  return {
    authorizationHeaders: headers,
    async verify(config, driver, providerCredential) {
      const deadline = Date.now() + notReadyRetry.windowMs;
      for (
        let delayMs = notReadyRetry.initialDelayMs;
        ;
        delayMs = Math.min(delayMs * 2, MAX_NOT_READY_DELAY_MS)
      ) {
        try {
          return await verifyOnce(config, driver, providerCredential);
        } catch (error) {
          if (!isManagerNotReady(error) || Date.now() + delayMs >= deadline) throw error;
        }
        await sleep(delayMs);
      }
    },
    async allocate(context, spec, toolSandbox, providerCredential) {
      const request = doFetch(`${base}/runtimes`, {
        method: 'POST',
        headers: {
          ...headers(),
          'Content-Type': 'application/json',
          ...credentialHeader(providerCredential),
        },
        body: JSON.stringify({
          workspaceId: context.principal.workspaceId,
          sessionId: context.session.id,
          // ENG-07 (#306): which engine this run is for, so the manager's driver starts it in that
          // engine's image. `run.engine` and not `agent.engine`: the run row records the engine the
          // session is pinned to, and that is the one the sandbox must actually carry.
          engine: context.run.engine ?? context.agent.engine,
          runSpec: spec,
          ...(toolSandbox === undefined ? {} : { toolSandbox }),
        }),
      });
      const response = await send('allocation', providerCredential, request);
      if (!response.ok) throw await managerFailure('allocation', response, providerCredential);
      const value = await jsonAnswer('allocation', response);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidAnswer('allocation', response.status, 'returned an invalid allocation');
      }
      const record = value as Record<string, unknown>;
      if (typeof record['runnerUrl'] !== 'string' || record['runnerUrl'].length === 0) {
        throw new Error('runtime manager allocation omitted runnerUrl');
      }
      const handle = record['handle'];
      if (handle === null || typeof handle !== 'object' || Array.isArray(handle)) {
        throw new Error('runtime manager allocation omitted its handle');
      }
      const sandbox = record['toolSandbox'];
      const origin =
        sandbox !== null && typeof sandbox === 'object'
          ? (sandbox as Record<string, unknown>)['origin']
          : undefined;
      if (toolSandbox !== undefined && (typeof origin !== 'string' || origin.length === 0)) {
        throw new Error('runtime manager allocation omitted the tool sandbox origin');
      }
      return {
        handle: handle as RuntimeHandle,
        runnerUrl: record['runnerUrl'],
        ...(toolSandbox === undefined ? {} : { toolSandboxOrigin: origin as string }),
      };
    },
    async openToolSandbox(input, providerCredential) {
      const request = doFetch(`${base}/tool-sandboxes`, {
        method: 'POST',
        headers: {
          ...headers(),
          'Content-Type': 'application/json',
          ...credentialHeader(providerCredential),
        },
        body: JSON.stringify(input),
      });
      const response = await send('tool-sandbox', providerCredential, request);
      if (!response.ok) throw await managerFailure('tool-sandbox', response, providerCredential);
      const value = await jsonAnswer('tool-sandbox', response);
      const sandbox = (value as { toolSandbox?: unknown } | null)?.toolSandbox;
      const origin = (sandbox as { origin?: unknown } | null | undefined)?.origin;
      if (typeof origin !== 'string' || origin.length === 0) {
        throw invalidAnswer('tool-sandbox', response.status, 'omitted the tool sandbox origin');
      }
      return origin;
    },
    async closeToolSandbox(workspaceId, clientId, providerCredential) {
      const request = doFetch(
        `${base}/tool-sandboxes/sessions/${encodeURIComponent(clientId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          method: 'DELETE',
          headers: { ...headers(), ...credentialHeader(providerCredential) },
          // Revokes await this close inline after committing; a hung manager must not stall them.
          signal: AbortSignal.timeout(10_000),
        },
      );
      const response = await send('tool-sandbox', providerCredential, request);
      if (response.status !== 204 && response.status !== 404) {
        throw await managerFailure('tool-sandbox', response, providerCredential);
      }
    },
    async releaseRunToolSandboxes(workspaceId, runId, providerCredential) {
      const request = doFetch(
        `${base}/tool-sandboxes/runs/${encodeURIComponent(runId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          method: 'DELETE',
          headers: { ...headers(), ...credentialHeader(providerCredential) },
          // A run's terminal status waits for this release, so a hung manager must not stall it.
          signal: AbortSignal.timeout(10_000),
        },
      );
      const response = await send('tool-sandbox', providerCredential, request);
      if (response.status !== 204 && response.status !== 404) {
        throw await managerFailure('tool-sandbox', response, providerCredential);
      }
    },
    async destroy(handleId, providerCredential) {
      const request = doFetch(`${base}/runtimes/${encodeURIComponent(handleId)}`, {
        method: 'DELETE',
        headers: { ...headers(), ...credentialHeader(providerCredential) },
      });
      const response = await send('destroy', providerCredential, request);
      if (response.status !== 204 && response.status !== 404) {
        throw await managerFailure('destroy', response, providerCredential);
      }
    },
  };
}

/** How long a liveness probe waits before treating the runner manager as unreachable. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Whether the runner manager answers its unauthenticated `GET /healthz` — the same check the
 * generated Compose project's healthcheck runs. Any failure (refused connection, timeout, a non-2xx
 * answer, an unusable URL) is `false`: a caller must never read "unknown" as "available".
 */
export async function probeRuntimeManager(
  baseUrl: string,
  doFetch: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const base = baseUrl.trim().replace(/\/+$/u, '');
  if (base.length === 0) return false;
  try {
    const response = await doFetch(`${base}/healthz`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Only the status matters; release the body so repeated probes do not hold sockets open.
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}
