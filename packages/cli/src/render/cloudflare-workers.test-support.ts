import type { DeploymentImages } from '../deployment.js';
import { defaultProfile } from '../profile-defaults.js';
import {
  CLOUDFLARE_CONTROL_PLANE_CONFIG_FILE,
  CLOUDFLARE_GATEWAY_CONFIG_FILE,
  CLOUDFLARE_MANAGER_CONFIG_FILE,
  renderCloudflareProject,
} from './cloudflare.js';

export const images: DeploymentImages = {
  web: `registry.example/web@sha256:${'1'.repeat(64)}`,
  gateway: `registry.example/gateway@sha256:${'2'.repeat(64)}`,
  runner: `registry.example/runner@sha256:${'3'.repeat(64)}`,
  runtime: `registry.example/runtime@sha256:${'4'.repeat(64)}`,
};

export function artefact() {
  const rendered = renderCloudflareProject(
    defaultProfile({ cloud: 'cloudflare', projectName: 'a' }),
    images,
  );
  if (rendered === null) throw new Error('expected a Cloudflare artefact');
  return rendered;
}

export const fileOf = (fileName: string) =>
  artefact().files.find((file) => file.fileName === fileName)?.contents ?? '';

interface FakeContainerOptions {
  failProbes?: number;
  /** Probes that never settle: a server that holds the connection open and says nothing. */
  hangProbes?: boolean;
  monitor?: () => Promise<void>;
  /** The error a forward to the server rejects with, once it listens. */
  failForward?: Error;
}

export function fakeContainer(options: FakeContainerOptions = {}) {
  const started: {
    entrypoint: string[];
    env: Record<string, string>;
    enableInternet: boolean;
  }[] = [];
  const inactivity: number[] = [];
  const forwarded: string[] = [];
  const forwardedRequests: (Request | RequestInit | undefined)[] = [];
  let destroyed = 0;
  const container = {
    running: false,
    start(settings: {
      entrypoint: string[];
      env: Record<string, string>;
      enableInternet: boolean;
    }) {
      started.push(settings);
      container.running = true;
    },
    destroy() {
      destroyed += 1;
      container.running = false;
      return Promise.resolve();
    },
    monitor: options.monitor ?? (() => new Promise<void>(() => undefined)),
    setInactivityTimeout(durationMs: number) {
      inactivity.push(durationMs);
      return Promise.resolve();
    },
    getTcpPort: containerPort(options, { forwarded, forwardedRequests }),
  };
  const stored = new Map<string, unknown>();
  const ctx = {
    container,
    storage: {
      get: (key: string) => Promise.resolve(stored.get(key)),
      put(key: string, value: unknown) {
        stored.set(key, value);
        return Promise.resolve();
      },
    },
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback(),
  };
  return {
    ctx,
    started,
    inactivity,
    forwarded,
    forwardedRequests,
    stored,
    destroyed: () => destroyed,
  };
}

type FakeContext = ReturnType<typeof fakeContainer>['ctx'];
/** Without Containers enabled for the class, Cloudflare gives the Durable Object no container. */
type FakeContainerState = Omit<FakeContext, 'container'> & {
  container: FakeContext['container'] | undefined;
};

interface LoadedWorker {
  readonly Instance: new (
    ctx: FakeContainerState,
    env: Record<string, unknown>,
  ) => { fetch(request: Request): Promise<Response> };
  readonly entry: {
    fetch(this: void, request: Request, env: Record<string, unknown>): Promise<Response>;
  };
}

/**
 * The three Container Workers share one template, so one suite holds each to it. The modules are the
 * committed goldens, which `artefacts.test.ts` pins byte-for-byte to the rendered ones.
 */
export const containerWorkers = [
  {
    service: 'control plane',
    configFile: CLOUDFLARE_CONTROL_PLANE_CONFIG_FILE,
    main: 'control-plane-worker.mjs',
    className: 'Web',
    binding: 'WEB',
    object: 'control-plane',
    image: images.web,
    port: 3000,
    entrypoint: ['node', '/srv/apps/web/node_modules/next/dist/bin/next', 'start'],
    secrets: {
      DATABASE_URL: 'postgres://db',
      MASTER_ENCRYPTION_KEY: 'k',
      SESSION_SECRET: 's',
      BOOTSTRAP_ADMIN: 'admin@example.com',
      BOOTSTRAP_ADMIN_PASSWORD: 'p',
    },
    load: async (): Promise<LoadedWorker> => {
      const module =
        await import('../fixtures/cloudflare/deploy-cloudflare-control-plane-worker.mjs');
      return { Instance: module.Web, entry: module.default };
    },
  },
  {
    service: 'model gateway',
    configFile: CLOUDFLARE_GATEWAY_CONFIG_FILE,
    main: 'gateway-worker.mjs',
    className: 'Gateway',
    binding: 'GATEWAY',
    object: 'gateway',
    image: images.gateway,
    port: 4000,
    entrypoint: ['node', 'packages/gateway/dist/index.js'],
    secrets: {
      DATABASE_URL: 'postgres://db',
      MASTER_ENCRYPTION_KEY: 'k',
      GATEWAY_TOKEN_SECRET: 't',
    },
    load: async (): Promise<LoadedWorker> => {
      const module = await import('../fixtures/cloudflare/deploy-cloudflare-gateway-worker.mjs');
      return { Instance: module.Gateway, entry: module.default };
    },
  },
  {
    service: 'runner manager',
    configFile: CLOUDFLARE_MANAGER_CONFIG_FILE,
    main: 'manager-worker.mjs',
    className: 'Manager',
    binding: 'MANAGER',
    object: 'manager',
    image: images.runner,
    port: 8090,
    entrypoint: ['node', 'dist/manager-start.js'],
    secrets: {
      RUNNER_MANAGER_TOKEN: 'm'.repeat(32),
      RUNTIME_DRIVER: 'external',
      GATEWAY_PUBLIC_URL: 'https://gateway.example',
      EXTERNAL_PROVIDER: 'e2b',
    },
    load: async (): Promise<LoadedWorker> => {
      const module = await import('../fixtures/cloudflare/deploy-cloudflare-manager-worker.mjs');
      return { Instance: module.Manager, entry: module.default };
    },
  },
];

function containerPort(
  options: FakeContainerOptions,
  observations: { forwarded: string[]; forwardedRequests: (Request | RequestInit | undefined)[] },
) {
  const { forwarded, forwardedRequests } = observations;
  let failures = options.failProbes ?? 0;
  return (port: number) => ({
    fetch(input: string | Request, init?: Request | RequestInit) {
      const url = typeof input === 'string' ? input : input.url;
      forwarded.push(`${String(port)} ${url}`);
      // A container port speaks plain HTTP: the real one throws for any other scheme.
      if (url.startsWith('https:')) {
        return Promise.reject(new TypeError('Fetch to a container port needs an http: URL'));
      }
      if (url !== 'http://container/') {
        forwardedRequests.push(init);
        if (options.failForward) return Promise.reject(options.failForward);
      }
      if (url === 'http://container/' && options.hangProbes === true) {
        return new Promise<Response>(() => undefined);
      }
      if (url === 'http://container/' && failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('connection refused'));
      }
      return Promise.resolve(new Response('web'));
    },
  });
}
