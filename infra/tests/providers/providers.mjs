/**
 * The three provider lanes: which environment each needs and how it builds the real driver from
 * the built `packages/runtime/dist`. Credentials are arguments of the driver calls (ADR-0120 LC6),
 * never put in a command line.
 *
 * Vendor facts live next to the drivers that rely on them (packages/runtime/src/external/e2b.ts,
 * vercel-sandbox.ts, cloudflare-sandbox.ts), each with its doc URL and the date checked:
 * https://docs.e2b.dev/sandbox/internet-access (2026-10-08),
 * https://vercel.com/docs/sandbox/concepts/firewall (2026-10-07),
 * https://developers.cloudflare.com/containers/platform-details/outbound-traffic/ (2026-10-07).
 */
import { deployBridge } from './cloudflare-bridge.mjs';

/** Both are IANA-run hosts outside every always-denied range; the probe image tries them on 443. */
export const GATEWAY_HOST = 'example.com';
export const PUBLIC_HOST = 'example.org';

const ENGINE = 'claude-agent-sdk';

/** The generic external driver, its e2b provider and `RuntimeRefusalError`. */
export const runtime = () => import('../../../packages/runtime/dist/external/index.js');

async function externalDriver(driverId, provider, image) {
  const { createExternalDriver } = await runtime();
  return createExternalDriver({
    driverId,
    provider,
    images: new Map([[ENGINE, image]]),
    gatewayUrl: `https://${GATEWAY_HOST}`,
    startAgent: () => {
      throw new Error('the provider lane never starts an agent');
    },
  });
}

/**
 * The provider API's answer for one sandbox: `stopped`, `running`, or why there is no definite
 * answer (the deadline check reads that as `inconclusive`). A 404 means stopped only with
 * `goneOn404`, where the endpoint is documented to answer it for a sandbox that no longer exists.
 */
async function providerState(url, headers, readStatus, { goneOn404 = false } = {}) {
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (goneOn404 && response.status === 404) {
    await response.body?.cancel();
    return 'stopped';
  }
  if (!response.ok) {
    await response.body?.cancel();
    return `lookup answered ${String(response.status)}`;
  }
  const status = readStatus(await response.json().catch(() => undefined));
  if (status === 'running' || status === 'stopped') return status;
  return `unknown state ${typeof status === 'string' ? status : '(unreadable)'}`;
}

/**
 * `credentials` are the environment variables the lane cannot run without; `secrets` is the subset
 * to redact. A missing credential makes every check `skipped` (never a pass). The probe artefact
 * (template, project, image) is not a credential: `prepare.mjs` resolves it into the `env` that
 * `open(env)` and `state(env, sandboxId)` read. `open` returns `{ driver, credential, close,
 * bridgeUrl?, bridgeCalls? }` (`bridgeCalls()` counts the driver's calls to the bridge); `state`, where present, asks the provider API whether a sandbox stopped.
 */
export const PROVIDERS = {
  e2b: {
    driverId: 'external',
    credentials: ['E2B_API_KEY'],
    secrets: ['E2B_API_KEY'],
    async open(env) {
      const { createE2bProvider } = await runtime();
      return {
        driver: await externalDriver('external', createE2bProvider(), env.E2B_PROBE_TEMPLATE),
        credential: env.E2B_API_KEY,
        close: async () => {},
      };
    },
    // GET /sandboxes/{sandboxID} answers 404 for a sandbox that was killed or timed out, and a
    // `state` of `running` or `paused` otherwise (https://e2b.dev/docs/api-reference, checked
    // 2026-10-08). `paused` is not a definite stop, so it reads inconclusive.
    state: (env, sandboxId) =>
      providerState(
        `https://api.e2b.app/sandboxes/${encodeURIComponent(sandboxId)}`,
        { 'x-api-key': env.E2B_API_KEY },
        (body) => body?.state,
        { goneOn404: true },
      ),
  },
  vercel: {
    driverId: 'vercel-sandbox',
    credentials: ['VERCEL_TOKEN', 'VERCEL_TEAM_ID'],
    secrets: ['VERCEL_TOKEN', 'VERCEL_TEAM_ID'],
    async open(env) {
      const { createVercelSandboxProvider } = await import(
        '../../../packages/runtime/dist/vercel-sandbox.js'
      );
      const provider = createVercelSandboxProvider({
        teamId: env.VERCEL_TEAM_ID,
        projectId: env.VERCEL_PROJECT_ID,
      });
      return {
        driver: await externalDriver('vercel-sandbox', provider, env.VERCEL_PROBE_IMAGE),
        credential: env.VERCEL_TOKEN,
        close: async () => {},
      };
    },
    // GET /v2/sandboxes/{name} of a named sandbox, whose session `status` is `running`, `stopped`
    // or another state (https://vercel.com/docs/rest-api/sandboxes, checked 2026-10-08). The shape
    // is unproven until this lane runs live, so a 404 or an unreadable body is not read as stopped.
    state: (env, sandboxName) => {
      const query = new URLSearchParams({ teamId: env.VERCEL_TEAM_ID, projectId: env.VERCEL_PROJECT_ID });
      return providerState(
        `https://api.vercel.com/v2/sandboxes/${encodeURIComponent(sandboxName)}?${query.toString()}`,
        { authorization: `Bearer ${env.VERCEL_TOKEN}` },
        (body) => body?.session?.status ?? body?.sandbox?.status,
      );
    },
  },
  cloudflare: {
    driverId: 'cloudflare-sandbox',
    credentials: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    secrets: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    async open(env) {
      const { createCloudflareSandboxProvider } = await import(
        '../../../packages/runtime/dist/cloudflare-sandbox.js'
      );
      const bridge = await deployBridge({
        image: env.CLOUDFLARE_PROBE_IMAGE,
        gatewayHost: GATEWAY_HOST,
        secrets: [env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID],
        sweepLeftovers: true,
      });
      try {
        // Counted so the lane can prove a refused policy never reached the bridge (ADR-0131).
        let bridgeCalls = 0;
        const provider = createCloudflareSandboxProvider({
          bridgeUrl: bridge.bridgeUrl,
          fetch: (...args) => {
            bridgeCalls += 1;
            return fetch(...args);
          },
        });
        return {
          driver: await externalDriver('cloudflare-sandbox', provider, env.CLOUDFLARE_PROBE_IMAGE),
          credential: bridge.bridgeSecret,
          bridgeUrl: bridge.bridgeUrl,
          bridgeCalls: () => bridgeCalls,
          close: bridge.remove,
        };
      } catch (error) {
        await bridge.remove().catch((cleanupError) => {
          throw new Error(`${error instanceof Error ? error.message : String(error)}; teardown also failed: ${cleanupError.message}`, { cause: error });
        });
        throw error;
      }
    },
  },
};
