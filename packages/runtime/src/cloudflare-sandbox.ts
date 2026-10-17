/**
 * The `cloudflare-sandbox` driver (ADR-0120 LC1-LC4, LC6): the `external` driver's HTTPS forwarding
 * and refusals under the id `cloudflare-sandbox`, with a provider that calls the bridge Worker this
 * repository ships (`infra/cloudflare/sandbox-bridge/`). Cloudflare has no REST API for a container
 * to call from here, so the bridge is the provider; no Cloudflare type crosses this file.
 *
 * The bridge secret is the provider credential (LC6): an argument of `create` and `destroy` only.
 * Reaching a sandbox needs the per-sandbox bearer (LC3) and an access token the bridge derived from
 * the sandbox id, so the manager keeps no bridge secret after the create call.
 *
 * Vendor facts below carry their source and the date they were last checked.
 */
import type { RuntimeCapabilities } from './driver.js';
import { createExternalDriver } from './external/driver.js';
import type {
  ExternalDriver,
  ExternalDriverOptions,
  ExternalProvider,
  ExternalSandbox,
} from './external/driver.js';

/**
 * ADR-0120's `cloudflare-sandbox` table. `maxSessionSeconds` is `null`: a container has no fixed
 * maximum lifetime and `sleepAfter` defaults to 10 minutes
 * (https://developers.cloudflare.com/containers/faq/, checked 2026-10-07). `networkPolicies` is
 * empty (ADR-0131): the bridge starts `none` with `enableInternet = false` and the gateway as the
 * only allowed host, yet the live lane still reached public, private, metadata and IPv6 targets,
 * because Cloudflare enforces outbound rules in an L7 proxy that accepts TCP on ports 80 and 443,
 * gates on the Host header and completes TLS with its own CA
 * (https://developers.cloudflare.com/containers/platform-details/outbound-traffic/, checked
 * 2026-10-09). `@cloudflare/containers@0.3.7` also matches `deniedHosts` as hostname globs, so a CIDR
 * entry never matches. Every policy is refused until a live lane proves egress denial.
 */
export function cloudflareSandboxRuntimeCapabilities(): RuntimeCapabilities {
  return {
    isolation: 'microvm',
    customImage: true,
    persistentFilesystem: false,
    sessionAffinity: true,
    maxSessionSeconds: null,
    networkPolicies: [],
    execCommands: true,
    gpu: false,
    managedByProvider: true,
    typicalStartMs: null,
  };
}

/** Named in the run-spec refusal; asserted verbatim by the suite. */
export const CLOUDFLARE_SANDBOX_RESTRICTED_REFUSAL =
  'external runtime: provider cloudflare-sandbox refuses the restricted network policy until the E4 live lane proves Cloudflare enforces the always-denied ranges (ADR-0120 LC4).';

const REQUEST_TIMEOUT_MS = 60_000;
const SANDBOX_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const ACCESS_TOKEN = /^[A-Za-z0-9._~+/=-]{16,512}$/u;

/**
 * Messages carry the operation and status only: a bridge body or a transport error may echo the
 * secret, so neither is ever put in an error (LC6).
 */
function failure(operation: string, status?: number): Error {
  return new Error(
    `external runtime: provider cloudflare-sandbox ${operation} failed${status === undefined ? '' : ` with status ${String(status)}`}.`,
  );
}

export function createCloudflareSandboxProvider(
  options: Readonly<{
    /** The deployed bridge Worker's origin, for example `https://bridge.example.workers.dev`. */
    bridgeUrl: string;
    fetch?: typeof globalThis.fetch;
  }>,
): ExternalProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  const bridge = options.bridgeUrl.replace(/\/+$/u, '');

  async function call(
    operation: string,
    path: string,
    bridgeSecret: string,
    init: RequestInit,
  ): Promise<Response> {
    try {
      return await doFetch(`${bridge}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${bridgeSecret}`, 'content-type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw failure(operation);
    }
  }

  async function destroy(sandboxId: string, bridgeSecret: string): Promise<void> {
    const response = await call(
      'destroy',
      `/v1/sandboxes/${encodeURIComponent(sandboxId)}`,
      bridgeSecret,
      { method: 'DELETE' },
    );
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) throw failure('destroy', response.status);
  }

  return {
    id: 'cloudflare-sandbox',
    capabilities: cloudflareSandboxRuntimeCapabilities(),
    restrictedRefusal: CLOUDFLARE_SANDBOX_RESTRICTED_REFUSAL,

    async create(request, bridgeSecret): Promise<ExternalSandbox> {
      const response = await call('create', '/v1/sandboxes', bridgeSecret, {
        method: 'POST',
        body: JSON.stringify({
          image: request.image,
          sessionKey: request.sessionKey,
          bearer: request.bearer,
          networkPolicy: request.networkPolicy,
          gatewayHost: request.gatewayHost,
          timeoutSeconds: request.timeoutSeconds,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw failure('create', response.status);
      }
      let created: unknown;
      try {
        created = await response.json();
      } catch {
        throw failure('create');
      }
      const record =
        typeof created === 'object' && created !== null ? (created as Record<string, unknown>) : {};
      const sandboxId = record['sandboxId'];
      const accessToken = record['accessToken'];
      if (typeof sandboxId !== 'string' || !SANDBOX_ID.test(sandboxId)) throw failure('create');
      if (typeof accessToken !== 'string' || !ACCESS_TOKEN.test(accessToken)) {
        // The sandbox exists but cannot be reached safely: do not leave it running.
        await destroy(sandboxId, bridgeSecret).catch(() => undefined);
        throw failure('create');
      }
      return {
        sandboxId,
        origin: `${bridge}/v1/sandboxes/${sandboxId}/runtime`,
        accessHeaders: { 'x-bridge-access': accessToken },
      };
    },

    destroy,
  };
}

export type CloudflareSandboxDriverOptions<TRequest, TEvent> = Omit<
  ExternalDriverOptions<TRequest, TEvent>,
  'driverId' | 'provider'
> &
  Readonly<{ bridgeUrl: string; fetch?: typeof globalThis.fetch }>;

export function createCloudflareSandboxDriver<TRequest, TEvent>(
  options: CloudflareSandboxDriverOptions<TRequest, TEvent>,
): ExternalDriver<TRequest, TEvent> {
  const { bridgeUrl, fetch, ...rest } = options;
  return createExternalDriver({
    ...rest,
    driverId: 'cloudflare-sandbox',
    provider: createCloudflareSandboxProvider({
      bridgeUrl,
      ...(fetch === undefined ? {} : { fetch }),
    }),
  });
}
