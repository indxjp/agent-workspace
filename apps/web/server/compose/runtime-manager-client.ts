import { createAllocation } from './runtime-manager-allocation';
import { credentialHeader } from './runtime-manager-errors';
export { withRunnerManagerIdentity } from './runtime-manager-identity';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  RuntimeManagerError,
  managerFailure,
  send,
  invalidAnswer,
  jsonAnswer,
} from './runtime-manager-errors';
export { RuntimeManagerError } from './runtime-manager-errors';

import type {
  RuntimeDriverId,
  RuntimeHandle,
  RuntimeRunSpec,
} from '@agent-workspace/runtime/driver';
import type { ToolSandboxRequest } from '@indx-workspace/contracts/agent-versions';

import { systemClock, type Clock } from '../clock';
import type { LaunchContext } from '../execution';

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

/**
 * How long `verify` keeps asking while the manager Worker answers `manager_not_ready`: its container
 * is still starting. Short, so a manager that never starts still fails inside setup's runtime-test
 * deadline; the delay doubles from `initialDelayMs` up to `MAX_NOT_READY_DELAY_MS`.
 */
export type NotReadyRetry = Readonly<{ windowMs: number; initialDelayMs: number }>;

/** Revocations and terminal run transitions await sandbox cleanup inline. */
const SANDBOX_CLOSE_TIMEOUT_MS = 10_000;

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
    /** Where the not-ready retry window reads the time; the system clock by default. */
    clock?: Clock;
  }> = {},
): RuntimeManagerClient {
  if (baseUrl.trim().length === 0) throw new Error('runtime manager URL is required');
  if (token.length < 32)
    throw new Error('runtime manager token must contain at least 32 characters');
  const base = baseUrl.replace(/\/+$/u, '');
  const headers = () => ({ Authorization: `Bearer ${token}` });
  const transport = { base, headers, doFetch };
  return {
    authorizationHeaders: headers,
    verify: createVerification(transport, options),
    allocate: createAllocation(transport),
    ...createSandboxOperations(transport),
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

export type ManagerTransport = Readonly<{
  base: string;
  headers: () => Readonly<Record<string, string>>;
  doFetch: typeof globalThis.fetch;
}>;
function createVerificationAttempt(
  { base, headers, doFetch }: ManagerTransport,
  verificationNetworkPolicy: RuntimeRunSpec['networkPolicy'],
): RuntimeManagerClient['verify'] {
  return async (config, driver, providerCredential) => {
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
}
function createVerification(
  transport: ManagerTransport,
  options: Parameters<typeof createRuntimeManagerClient>[3],
): RuntimeManagerClient['verify'] {
  const notReadyRetry = options?.notReadyRetry ?? DEFAULT_NOT_READY_RETRY;
  const clock = options?.clock ?? systemClock;
  const verifyOnce = createVerificationAttempt(
    transport,
    options?.verificationNetworkPolicy ?? 'none',
  );
  return async (config, driver, providerCredential) => {
    const deadline = clock.now().getTime() + notReadyRetry.windowMs;
    for (
      let delayMs = notReadyRetry.initialDelayMs;
      ;
      delayMs = Math.min(delayMs * 2, MAX_NOT_READY_DELAY_MS)
    ) {
      try {
        return await verifyOnce(config, driver, providerCredential);
      } catch (error) {
        if (!isManagerNotReady(error) || clock.now().getTime() + delayMs >= deadline) throw error;
      }
      await sleep(delayMs);
    }
  };
}
function createDeletion({ base, headers, doFetch }: ManagerTransport) {
  return async (
    path: string,
    what: string,
    providerCredential: string | undefined,
    timeoutMs?: number,
  ): Promise<void> => {
    const request = doFetch(`${base}${path}`, {
      method: 'DELETE',
      headers: { ...headers(), ...credentialHeader(providerCredential) },
      ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
    });
    const response = await send(what, providerCredential, request);
    if (response.status !== 204 && response.status !== 404)
      throw await managerFailure(what, response, providerCredential);
  };
}
function createSandboxOperations({
  base,
  headers,
  doFetch,
}: ManagerTransport): Pick<
  RuntimeManagerClient,
  'openToolSandbox' | 'closeToolSandbox' | 'releaseRunToolSandboxes' | 'destroy'
> {
  const deleteResource = createDeletion({ base, headers, doFetch });
  return {
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
      return deleteResource(
        `/tool-sandboxes/sessions/${encodeURIComponent(clientId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
        'tool-sandbox',
        providerCredential,
        SANDBOX_CLOSE_TIMEOUT_MS,
      );
    },

    async releaseRunToolSandboxes(workspaceId, runId, providerCredential) {
      return deleteResource(
        `/tool-sandboxes/runs/${encodeURIComponent(runId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
        'tool-sandbox',
        providerCredential,
        SANDBOX_CLOSE_TIMEOUT_MS,
      );
    },

    async destroy(handleId, providerCredential) {
      return deleteResource(
        `/runtimes/${encodeURIComponent(handleId)}`,
        'destroy',
        providerCredential,
      );
    },
  };
}
