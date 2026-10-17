/**
 * The bridge Worker entry (ADR-0120 LC2): two Cloudflare Container classes, one per network policy,
 * because outbound settings are class-level
 * (https://developers.cloudflare.com/containers/platform-details/outbound-traffic/, checked
 * 2026-10-08), and `bridge.ts` for the protocol. Uses the Containers `Container` class, not
 * `@cloudflare/sandbox`. NOT YET VERIFIED LIVE: this file is deployed only by the opt-in lane
 * (`infra/tests/providers/lane.test.mjs`), and the Container API below is taken
 * from https://developers.cloudflare.com/containers/container-package/ (checked 2026-10-08).
 */
import { Container } from '@cloudflare/containers';

import { DENIED_RANGES, containerSettings, handleBridgeRequest } from './bridge.js';
import type { BridgeEnv, NetworkPolicy, SandboxStub } from './bridge.js';

// Outbound interception (`allowedHosts`, `deniedHosts`, `interceptHttps`) needs the proxy exported
// from the entry module, or every container start throws.
export { ContainerProxy } from '@cloudflare/containers';

interface DurableObjectState {
  storage: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    deleteAll(): Promise<void>;
  };
  blockConcurrencyWhile(callback: () => Promise<void>): Promise<void>;
}

interface Env {
  BRIDGE_SECRET: string;
  RUNTIME_IMAGE: string;
  GATEWAY_HOST: string;
  SANDBOX_NONE: SandboxNamespace;
  SANDBOX_OPEN: SandboxNamespace;
}

interface SandboxRpc {
  begin(settings: { bearer: string; timeoutSeconds: number }): Promise<void>;
  end(): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

interface SandboxNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): SandboxRpc;
}

// The container must trust Cloudflare's interception CA, because `interceptHttps` re-signs HTTPS
// to the gateway host (outbound-traffic page, checked 2026-10-08).
const INTERCEPT_CA = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const RUNNER_PORT = 8080;

class RunnerContainer extends Container<Env> {
  defaultPort = RUNNER_PORT;
  requiredPorts = [RUNNER_PORT];
  interceptHttps = true;
  // NOT ENFORCED (LC4): 0.3.7 matches `deniedHosts` as hostname globs, so these CIDRs match nothing.
  // The bridge refuses `open`, so only `SandboxNone` (allowedHosts = gateway) is ever started.
  deniedHosts = [...DENIED_RANGES];
  // ponytail: activity-based, not an absolute deadline (the manager holds the session deadline);
  // an absolute stop needs a Durable Object alarm, add it if sessions must die at the deadline.
  sleepAfter = '10m';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx as never, env);
    void ctx.blockConcurrencyWhile(async () => {
      const bearer = await ctx.storage.get('bearer');
      const sleepAfter = await ctx.storage.get('sleepAfter');
      if (typeof bearer === 'string') this.useBearer(bearer);
      if (typeof sleepAfter === 'string') this.sleepAfter = sleepAfter;
    });
  }

  private useBearer(bearer: string): void {
    this.envVars = { RUNTIME_SANDBOX_BEARER: bearer, NODE_EXTRA_CA_CERTS: INTERCEPT_CA };
  }

  async begin(settings: { bearer: string; timeoutSeconds: number }): Promise<void> {
    const sleepAfter = `${String(settings.timeoutSeconds)}s`;
    await this.ctx.storage.put('bearer', settings.bearer);
    await this.ctx.storage.put('sleepAfter', sleepAfter);
    this.useBearer(settings.bearer);
    this.sleepAfter = sleepAfter;
    await this.startAndWaitForPorts();
  }

  async end(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.destroy();
  }

  // A destroyed or never-created sandbox must not auto-start without a bearer: the runner server
  // leaves its routes open when no bearer is set (LC3).
  override async fetch(request: Request): Promise<Response> {
    if (typeof (await this.ctx.storage.get('bearer')) !== 'string') {
      return new Response(null, { status: 404 });
    }
    return await super.fetch(request);
  }
}

export class SandboxNone extends RunnerContainer {
  enableInternet = containerSettings('none', '').enableInternet;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.allowedHosts = containerSettings('none', env.GATEWAY_HOST).allowedHosts ?? [];
  }
}

// Unreachable until F-LC4-open: the bridge refuses `open`, because nothing here enforces the
// always-denied ranges at IP level yet. Kept so the deployed class set does not change later.
export class SandboxOpen extends RunnerContainer {
  enableInternet = containerSettings('open', '').enableInternet;
}

function stubFor(namespace: SandboxNamespace, id: string): SandboxStub {
  const stub = namespace.get(namespace.idFromName(id));
  return {
    start: (settings) => stub.begin(settings),
    forward: (request) => stub.fetch(request),
    destroy: () => stub.end(),
  };
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const bridge: BridgeEnv = {
      bridgeSecret: env.BRIDGE_SECRET,
      runtimeImage: env.RUNTIME_IMAGE,
      gatewayHost: env.GATEWAY_HOST,
      sandbox: (policy: NetworkPolicy, id: string) =>
        stubFor(policy === 'none' ? env.SANDBOX_NONE : env.SANDBOX_OPEN, id),
    };
    return handleBridgeRequest(request, bridge);
  },
};
