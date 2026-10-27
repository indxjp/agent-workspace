/**
 * The Vercel Sandbox provider behind the `vercel-sandbox` driver (ADR-0120 LC1-LC4, LC6), over REST
 * with `fetch`: `@vercel/sandbox` is on `denyByName`, and no Vercel type leaves this file. It plugs
 * into `createExternalDriver`, so the bearer, the live table, the HTTPS forwarding and the refusals
 * are the ones `external` already has.
 *
 * Vendor facts below carry their source and the date they were last checked, 2026-10-08. None has
 * been exercised against the live service yet; the opt-in live lane (follow-up) is where they are
 * proven.
 */
import { randomBytes } from 'node:crypto';

import type { RuntimeCapabilities } from './driver.js';
import type {
  ExternalProvider,
  ExternalSandbox,
  ExternalSandboxRequest,
  FoundExternalSandbox,
} from './external/driver.js';
import { ALWAYS_DENIED_RANGES } from './external/e2b.js';

export type VercelPlanTier = 'hobby' | 'pro';

/**
 * ADR-0120's `vercel-sandbox` table. `maxSessionSeconds` is 45 min on Hobby and 24 h on Pro
 * (https://vercel.com/docs/sandbox/pricing, checked 2026-10-07). `networkPolicies` omits `allowlist`
 * (LC4): Vercel documents denied CIDRs as taking precedence over allowed domains, but the order
 * against an allowed-domain SNI match is unverified until E7's live lane proves it
 * (https://vercel.com/docs/sandbox/concepts/firewall, checked 2026-10-07).
 */
export function vercelSandboxRuntimeCapabilities(
  tier: VercelPlanTier = 'hobby',
): RuntimeCapabilities {
  return {
    isolation: 'microvm',
    customImage: true,
    persistentFilesystem: false,
    sessionAffinity: true,
    maxSessionSeconds: tier === 'pro' ? 86_400 : 2_700,
    networkPolicies: ['none', 'open'],
    execCommands: true,
    gpu: false,
    managedByProvider: true,
    typicalStartMs: null,
    fileTransfer: 'push-archive',
  };
}

const RESTRICTED_REFUSAL =
  'vercel-sandbox runtime: refuses the restricted network policy until the E7 live lane proves a denied CIDR beats an allowed domain matched by SNI (ADR-0120 LC4).';

const BEARER_ENV = 'RUNTIME_SANDBOX_BEARER';
const RUNNER_PORT = 8080;
/** `runtime.Dockerfile`'s `CMD`: Vercel does not run an image's ENTRYPOINT or CMD (LC2). */
const RUNNER_ENTRY = '/srv/apps/runner/dist/index.js';
const RUNNER_CWD = '/workspace';
const REQUEST_TIMEOUT_MS = 30_000;
const CREATE_TIMEOUT_MS = 120_000;
const NAMED_CREATE_ATTEMPTS = 30;
const NAMED_RETRY_DELAY_MS = 1_000;
const SANDBOX_NAME = /^[A-Za-z0-9_-]{1,128}$/u;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/**
 * LC4 mapping, in the request shape the Vercel Sandbox API accepts: `@vercel/sandbox@3.6.0` sends
 * `{ allow?, subnets?: { allow?, deny? } }` or `{ mode: 'allow-all' | 'deny-all' }`
 * (`NetworkPolicyRequestValidator` in https://unpkg.com/@vercel/sandbox@3.6.0/dist/api-client/validators.js,
 * checked 2026-10-08), and the create page lists the same `oneOf`
 * (https://vercel.com/docs/rest-api/sandboxes/create-a-named-sandbox-2, checked 2026-10-08).
 * `mode: 'custom'` with `allowedDomains`/`allowedCIDRs`/`deniedCIDRs` is the response-only shape
 * and is answered `400`. A user-defined policy denies by default, denied ranges take precedence over
 * every allow, and `0.0.0.0/0` / `::/0` in `subnets.allow` grant the whole Internet
 * (https://vercel.com/docs/sandbox/concepts/firewall, checked 2026-10-08). So `none` allows the
 * gateway host alone and `open` allows `0.0.0.0/0`; both deny the IPv4 always-denied ranges.
 *
 * `subnets` accepts IPv4 CIDRs only: providers-live run 37771522792 (2026-10-08) answered every
 * create `400 bad_request: Invalid CIDR "fe80::/10"` (`none`) / `Invalid CIDR "::/0"` (`open`). So
 * the IPv6 entries of `ALWAYS_DENIED_RANGES` (`fe80::/10`, `fc00::/7`, `::1/128`) are NOT sent, and
 * Vercel's policy cannot express an IPv6 denial. IPv6 egress denial is therefore not configured
 * through this policy and is covered only by the lane's `no-ipv6-egress` proof (issue #832); if
 * that proof fails, `vercel-sandbox` must refuse untrusted sessions by name.
 */
function networkPolicyBody(request: ExternalSandboxRequest): Record<string, unknown> {
  const deny = ALWAYS_DENIED_RANGES.filter((range) => !range.includes(':'));
  return request.networkPolicy === 'none'
    ? { allow: [request.gatewayHost], subnets: { deny } }
    : { subnets: { allow: ['0.0.0.0/0'], deny } };
}

/**
 * Messages carry the operation, the status and, when the provider sent one, its error code and a
 * short redacted reason (`providerDetail`). A transport error may echo the token, so it is never put
 * in an error (LC6).
 */
function failure(operation: string, status?: number, detail?: string): Error {
  return new Error(
    `vercel-sandbox runtime: provider vercel ${operation} failed${status === undefined ? '' : ` with status ${String(status)}`}${detail === undefined ? '' : ` (${detail})`}.`,
  );
}

const DETAIL_MAX_BYTES = 4_096;
const DETAIL_REASON_MAX = 160;
const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/u;

/**
 * Reads at most 4 KiB of a failed response and reduces `{ error: { code, message } }` to
 * `code <code>: <reason>`. The provider text goes to stderr and lane logs, so the reason loses the
 * literal token, any `Bearer` value and any long opaque run, and is capped. It never throws: an
 * unreadable, oversized or non-JSON body gives `undefined` and the message keeps only the status.
 */
async function providerDetail(response: Response, token: string): Promise<string | undefined> {
  try {
    const reader = response.body?.getReader();
    if (reader === undefined) return undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < DETAIL_MAX_BYTES) {
      const next = await reader.read();
      const value: unknown = next.value;
      if (next.done || !(value instanceof Uint8Array)) break;
      chunks.push(value);
      size += value.length;
    }
    await reader.cancel();
    const error = asRecord(
      asRecord(
        JSON.parse(
          new TextDecoder().decode(Buffer.concat(chunks).subarray(0, DETAIL_MAX_BYTES)),
        ) as unknown,
      )['error'],
    );
    const code = error['code'];
    const message = error['message'];
    const reason =
      typeof message === 'string'
        ? message
            .split(token)
            .join('[redacted]')
            .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
            .replace(/[A-Za-z0-9_~+=-]{20,}/gu, '[redacted]')
            .replace(/\s+/gu, ' ')
            .trim()
            .slice(0, DETAIL_REASON_MAX)
        : '';
    const codePart = typeof code === 'string' && ERROR_CODE.test(code) ? `code ${code}` : '';
    if (codePart === '') return reason === '' ? undefined : reason;
    return reason === '' ? codePart : `${codePart}: ${reason}`;
  } catch {
    return undefined;
  }
}

async function failed(operation: string, response: Response, token: string): Promise<Error> {
  return failure(operation, response.status, await providerDetail(response, token));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The public origin of the runner port, taken from the create response's `routes` (LC3). */
function runnerOrigin(routes: unknown): string | undefined {
  if (!Array.isArray(routes)) return undefined;
  for (const route of routes as unknown[]) {
    const record = asRecord(route);
    if (record['port'] !== RUNNER_PORT || typeof record['url'] !== 'string') continue;
    try {
      const url = new URL(record['url']);
      if (url.protocol === 'https:' && url.username === '' && url.password === '') {
        return url.origin;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function createVercelSandboxProvider(
  options: Readonly<{
    teamId: string;
    projectId: string;
    tier?: VercelPlanTier;
    apiBase?: string;
    fetch?: typeof globalThis.fetch;
    /** Pause between looks at a sandbox another create of the same session is still bringing up. */
    retryDelayMs?: number;
  }>,
): ExternalProvider {
  const retryDelayMs = options.retryDelayMs ?? NAMED_RETRY_DELAY_MS;
  const doFetch = options.fetch ?? globalThis.fetch;
  const apiBase = (options.apiBase ?? 'https://api.vercel.com').replace(/\/+$/u, '');
  const capabilities = vercelSandboxRuntimeCapabilities(options.tier);

  async function call(
    operation: string,
    path: string,
    token: string,
    init: RequestInit,
    query: Record<string, string> = {},
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const search = new URLSearchParams({ teamId: options.teamId, ...query });
    try {
      return await doFetch(`${apiBase}${path}?${search.toString()}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw failure(operation);
    }
  }

  async function post(
    operation: string,
    path: string,
    token: string,
    body: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    const response = await call(
      operation,
      path,
      token,
      { method: 'POST', body: JSON.stringify(body) },
      {},
      timeoutMs,
    );
    if (!response.ok) throw await failed(operation, response, token);
    try {
      return await response.json();
    } catch {
      throw failure(operation);
    }
  }

  async function destroy(sandboxName: string, token: string): Promise<void> {
    // DELETE /v2/sandboxes/{name} stops a running session first and answers 404 for an unknown or
    // already-deleted sandbox (https://vercel.com/docs/rest-api/sandboxes/delete-a-sandbox,
    // checked 2026-10-08). Deleting the named sandbox also drops its snapshots with it.
    const response = await call(
      'destroy',
      `/v2/sandboxes/${encodeURIComponent(sandboxName)}`,
      token,
      { method: 'DELETE' },
      { projectId: options.projectId },
    );
    if (response.ok || response.status === 404) {
      await response.body?.cancel();
      return;
    }
    throw await failed('destroy', response, token);
  }

  /**
   * POST /v4/sandboxes (https://vercel.com/docs/rest-api/sandboxes/create-a-named-sandbox-2,
   * checked 2026-10-08; /v2 and /v3 also exist, v4 is the newest listed). The image is the
   * digest-pinned reference (LC2) and is not run through ENTRYPOINT/CMD. `persistent: false`
   * keeps the sandbox from snapshotting on stop. The bearer is not sent here: it goes only to the
   * start command's environment, so the sandbox record never holds it. The page lists a `409`
   * without a description; it is read as "that name is taken" (undefined here) and nothing is
   * deleted on it. That meaning is not yet proven live (E7), so the caller re-reads the name.
   */
  async function postCreate(
    request: ExternalSandboxRequest,
    token: string,
    name: string,
  ): Promise<Record<string, unknown> | undefined> {
    const response = await call(
      'create',
      '/v4/sandboxes',
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          name,
          projectId: options.projectId,
          image: request.image,
          ports: [RUNNER_PORT],
          timeout: request.timeoutSeconds * 1_000,
          persistent: false,
          networkPolicy: networkPolicyBody(request),
        }),
      },
      {},
      CREATE_TIMEOUT_MS,
    );
    if (response.status === 409) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) throw await failed('create', response, token);
    try {
      return asRecord(await response.json());
    } catch {
      throw failure('create');
    }
  }

  async function startCreated(
    request: ExternalSandboxRequest,
    token: string,
    name: string,
    created: Record<string, unknown>,
  ): Promise<ExternalSandbox> {
    const requestedMs = request.timeoutSeconds * 1_000;
    const session = asRecord(created['session']);
    const sessionId = session['id'];
    const origin = runnerOrigin(created['routes']);
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || origin === undefined) {
      throw failure('create');
    }
    // The session may grant less than asked for; extend by the difference. The driver already
    // clamped the request to `capabilities.maxSessionSeconds`, and Vercel refuses past the plan's
    // own maximum (https://vercel.com/docs/rest-api/sandboxes/extend-session-timeout, checked
    // 2026-10-08).
    const grantedMs = session['timeout'];
    if (typeof grantedMs === 'number' && grantedMs < requestedMs) {
      await post('extend', `/v2/sandboxes/sessions/${sessionId}/extend-timeout`, token, {
        duration: requestedMs - grantedMs,
      });
    }
    // POST .../cmd without `wait` returns at once with the command id
    // (https://vercel.com/docs/rest-api/sandboxes/execute-a-command, checked 2026-10-08). The
    // image's own ENV is not assumed to apply, so the runner's settings are spelled out.
    await post('start the runner', `/v2/sandboxes/sessions/${sessionId}/cmd`, token, {
      command: 'node',
      args: [RUNNER_ENTRY],
      cwd: RUNNER_CWD,
      env: {
        [BEARER_ENV]: request.bearer,
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: String(RUNNER_PORT),
      },
    });
    return { sandboxId: name, origin, accessHeaders: {} };
  }

  async function get(
    operation: string,
    path: string,
    token: string,
    query: Record<string, string> = {},
  ): Promise<unknown> {
    const response = await call(operation, path, token, { method: 'GET' }, query);
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) throw await failed(operation, response, token);
    try {
      return await response.json();
    } catch {
      throw failure(operation);
    }
  }

  type NamedState =
    | Readonly<{ kind: 'absent' | 'stopped' | 'busy' }>
    | Readonly<{ kind: 'usable'; sandbox: FoundExternalSandbox }>;

  /**
   * GET /v2/sandboxes/{name} answers the named sandbox with `status` (running | stopping |
   * stopped), `currentSessionId` and, while a session runs, `expiresAt` in epoch milliseconds; 404
   * when it does not exist (https://vercel.com/docs/rest-api/sandboxes/delete-a-sandbox documents
   * the shared object, checked 2026-10-08). Its routes are on the session:
   * GET /v2/sandboxes/sessions/{sessionId} (https://vercel.com/docs/rest-api/sandboxes/get-a-session,
   * checked 2026-10-08). `stopped` is the only state read as dead; anything else that is not yet
   * usable is `busy`, because another create of the same session may still be starting it.
   */
  async function namedState(name: string, token: string): Promise<NamedState> {
    const named = asRecord(
      asRecord(
        await get('find', `/v2/sandboxes/${encodeURIComponent(name)}`, token, {
          projectId: options.projectId,
        }),
      )['sandbox'],
    );
    const status = named['status'];
    if (status === undefined) return { kind: 'absent' };
    if (status === 'stopped') return { kind: 'stopped' };
    const sessionId = named['currentSessionId'];
    const expiresAt = named['expiresAt'];
    if (
      status !== 'running' ||
      typeof sessionId !== 'string' ||
      !SESSION_ID.test(sessionId) ||
      typeof expiresAt !== 'number'
    ) {
      return { kind: 'busy' };
    }
    const session = asRecord(
      await get('find', `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}`, token),
    );
    const origin = runnerOrigin(session['routes']);
    if (origin === undefined || asRecord(session['session'])['status'] !== 'running') {
      return { kind: 'busy' };
    }
    return { kind: 'usable', sandbox: { sandboxId: name, origin, accessHeaders: {}, expiresAt } };
  }

  /**
   * Idempotent per session (ADR-0126): two creates of one name never delete each other's sandbox.
   * It reuses a usable sandbox, deletes one only when the provider says it is stopped, waits out a
   * sandbox that is still coming up, and reads a `409` as "another create won" and looks again.
   * Whether the runner inside answers is the caller's wait, as for any create.
   *
   * ponytail: a stopped sandbox is deleted by name after a separate read, so a create landing
   * between the two round trips can lose its fresh sandbox; closing that needs a conditional delete
   * from the provider. Add it when the live lane (E7) shows it matters.
   */
  async function createNamed(
    request: ExternalSandboxRequest,
    token: string,
    name: string,
  ): Promise<ExternalSandbox> {
    for (let attempt = 0; attempt < NAMED_CREATE_ATTEMPTS; attempt += 1) {
      const state = await namedState(name, token);
      if (state.kind === 'usable') return state.sandbox;
      if (state.kind === 'busy') {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      if (state.kind === 'stopped') await destroy(name, token);
      const created = await postCreate(request, token, name);
      if (created === undefined) {
        // A lost race: the rival's sandbox may not be readable yet, so wait as for `busy`.
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      try {
        return await startCreated(request, token, name, created);
      } catch (error) {
        // Our own POST succeeded, so this sandbox is ours to remove; a 404 is accepted.
        await destroy(name, token).catch(() => undefined);
        throw error;
      }
    }
    throw failure('create');
  }

  return {
    id: 'vercel',
    capabilities,
    restrictedRefusal: RESTRICTED_REFUSAL,

    async create(request, token): Promise<ExternalSandbox> {
      // A sandbox name is unique per project and URL-safe. Ours is random, so a retry never
      // collides and no session key reaches the provider. A stateless driver (ADR-0126) names it
      // from its lookup key instead, so `find` can reach it; `createNamed` makes that idempotent.
      if (request.lookupKey !== undefined) {
        return await createNamed(request, token, `aw-${request.lookupKey}`);
      }
      const name = `aw-${randomBytes(18).toString('base64url')}`;
      try {
        const created = await postCreate(request, token, name);
        if (created === undefined) throw failure('create', 409);
        return await startCreated(request, token, name, created);
      } catch (error) {
        // The sandbox may exist (a later step failed, or a response was lost): do not leave it
        // running. Deleting an unknown name is a 404, which `destroy` accepts.
        await destroy(name, token).catch(() => undefined);
        throw error;
      }
    },

    async destroy(sandboxId, token): Promise<void> {
      if (!SANDBOX_NAME.test(sandboxId)) throw failure('destroy');
      await destroy(sandboxId, token);
    },

    async find(lookupKey, token): Promise<FoundExternalSandbox | undefined> {
      const name = `aw-${lookupKey}`;
      if (!SANDBOX_NAME.test(name)) throw failure('find');
      const state = await namedState(name, token);
      return state.kind === 'usable' ? state.sandbox : undefined;
    },
  };
}
