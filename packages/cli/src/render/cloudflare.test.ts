import { describe, expect, it, vi } from 'vitest';

import type { DeploymentImages } from '../deployment.js';
import { defaultProfile } from '../profile-defaults.js';
import {
  CLOUDFLARE_CONFIG_FILE,
  CLOUDFLARE_CONTROL_PLANE_CONFIG_FILE,
  CLOUDFLARE_GATEWAY_CONFIG_FILE,
  CLOUDFLARE_MANAGER_CONFIG_FILE,
  CLOUDFLARE_RETENTION_CRON_PATH,
  CLOUDFLARE_WORKER_FILE,
  cloudflareFrontendConfiguration,
  renderCloudflareProject,
} from './cloudflare.js';

const images: DeploymentImages = {
  web: `registry.example/web@sha256:${'1'.repeat(64)}`,
  gateway: `registry.example/gateway@sha256:${'2'.repeat(64)}`,
  runner: `registry.example/runner@sha256:${'3'.repeat(64)}`,
  runtime: `registry.example/runtime@sha256:${'4'.repeat(64)}`,
};

function artefact() {
  const rendered = renderCloudflareProject(
    defaultProfile({ cloud: 'cloudflare', projectName: 'a' }),
    images,
  );
  if (rendered === null) throw new Error('expected a Cloudflare artefact');
  return rendered;
}

const fileOf = (fileName: string) =>
  artefact().files.find((file) => file.fileName === fileName)?.contents ?? '';

describe('the Cloudflare platform Worker', () => {
  it('declares one daily retention Cron Trigger and carries no name, account or secret', () => {
    expect(artefact().directory).toBe('cloudflare');
    expect(JSON.parse(fileOf(CLOUDFLARE_CONFIG_FILE))).toEqual({
      main: CLOUDFLARE_WORKER_FILE,
      compatibility_date: '2026-10-01',
      workers_dev: false,
      triggers: { crons: ['0 3 * * *'] },
    });
    expect(CLOUDFLARE_RETENTION_CRON_PATH).toBe('/api/cron/retention');
  });

  it.each(['aws', 'gcp', 'azure', 'local', 'vercel'] as const)(
    'renders nothing for %s',
    (cloud) => {
      expect(
        renderCloudflareProject(defaultProfile({ cloud, projectName: 'a' }), images),
      ).toBeNull();
    },
  );

  describe('the scheduled handler', () => {
    // The committed golden, which `artefacts.test.ts` pins byte-for-byte to the rendered Worker.
    async function handler() {
      const module = await import('../fixtures/cloudflare/deploy-cloudflare-retention-worker.mjs');
      return module.default.scheduled;
    }
    const env = { CONTROL_PLANE_URL: 'https://app.example', CRON_SECRET: 'cron-secret' };

    it('calls the retention route with the bearer', async () => {
      const fetchStub = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
      vi.stubGlobal('fetch', fetchStub);
      try {
        await (
          await handler()
        )(undefined, env);
      } finally {
        vi.unstubAllGlobals();
      }
      const [url, init] = fetchStub.mock.calls[0] ?? [];
      expect(url).toBe('https://app.example/api/cron/retention');
      expect(init?.headers).toEqual({ authorization: 'Bearer cron-secret' });
    });

    it('fails the invocation when the route refuses, and when it is unconfigured', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response('', { status: 401 }))),
      );
      try {
        await expect((await handler())(undefined, env)).rejects.toThrow('answered 401');
      } finally {
        vi.unstubAllGlobals();
      }
      await expect((await handler())(undefined, { ...env, CRON_SECRET: '' })).rejects.toThrow(
        'CRON_SECRET is not set',
      );
      await expect((await handler())(undefined, { ...env, CONTROL_PLANE_URL: '' })).rejects.toThrow(
        'CONTROL_PLANE_URL is not set',
      );
    });
  });
});

interface FakeContainerOptions {
  failProbes?: number;
  /** Probes that never settle: a server that holds the connection open and says nothing. */
  hangProbes?: boolean;
  monitor?: () => Promise<void>;
  /** The error a forward to the server rejects with, once it listens. */
  failForward?: Error;
}

function fakeContainer(options: FakeContainerOptions = {}) {
  let failures = options.failProbes ?? 0;
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
    getTcpPort: (port: number) => ({
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
    }),
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
const containerWorkers = [
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

describe.each(containerWorkers)('the $service Worker', (worker) => {
  const secrets: Record<string, string> = worker.secrets;

  it('runs its image pin as one Container behind one Durable Object, with no name, account or secret', () => {
    expect(JSON.parse(fileOf(worker.configFile))).toEqual({
      main: worker.main,
      compatibility_date: '2026-10-01',
      workers_dev: true,
      containers: [
        {
          class_name: worker.className,
          image: worker.image,
          max_instances: 1,
          instance_type: 'standard-1',
        },
      ],
      durable_objects: { bindings: [{ name: worker.binding, class_name: worker.className }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: [worker.className] }],
    });
  });

  it('starts the server without migrating, hands the Worker secrets to the container, and proxies to its port', async () => {
    const { Instance } = await worker.load();
    const fake = fakeContainer();
    const object = new Instance(fake.ctx, { ...secrets, [worker.binding]: { binding: true } });

    const response = await object.fetch(new Request('https://app.example/health'));

    expect(await response.text()).toBe('web');
    expect(fake.started).toEqual([
      {
        entrypoint: worker.entrypoint,
        env: { ...secrets, AW_CONTAINER_IDLE_STOP_SECONDS: '900' },
        // The server connects out at boot (database, object storage, providers).
        enableInternet: true,
      },
    ]);
    expect(JSON.stringify(fake.started)).not.toContain('migrate');
    expect(fake.inactivity).toEqual([900_000]);
    expect(fake.forwarded).toContain(`${String(worker.port)} http://app.example/health`);
  });

  it('forwards the request to the container over http with its method and headers, and returns the answer', async () => {
    const { Instance } = await worker.load();
    const fake = fakeContainer();
    const object = new Instance(fake.ctx, secrets);

    const response = await object.fetch(
      new Request('https://app.example/setup?next=1', {
        method: 'POST',
        headers: { 'x-forwarded-proto': 'https' },
        body: 'payload',
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('web');
    expect(fake.forwarded).toContain(`${String(worker.port)} http://app.example/setup?next=1`);
    const [init] = fake.forwardedRequests;
    expect(init).toBeInstanceOf(Request);
    expect((init as Request).method).toBe('POST');
    expect((init as Request).headers.get('x-forwarded-proto')).toBe('https');
  });

  it('forwards Authorization and X-Provider-Credential unchanged', async () => {
    const { Instance } = await worker.load();
    const fake = fakeContainer();
    const object = new Instance(fake.ctx, secrets);

    await object.fetch(
      new Request('https://app.example/verify', {
        method: 'POST',
        headers: { authorization: 'Bearer manager-token', 'x-provider-credential': 'provider-key' },
        body: '{}',
      }),
    );

    const [init] = fake.forwardedRequests;
    expect((init as Request).headers.get('authorization')).toBe('Bearer manager-token');
    expect((init as Request).headers.get('x-provider-credential')).toBe('provider-key');
  });

  describe('when something throws', () => {
    interface Failure {
      readonly error: { readonly code: string; readonly step: string; readonly message: string };
    }
    const failureOf = async (response: Response): Promise<Failure> =>
      (await response.json()) as Failure;
    const silenced = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

    it('answers 502 JSON naming the forward step when the container rejects the forward', async () => {
      const error = silenced();
      try {
        const { Instance } = await worker.load();
        const fake = fakeContainer({ failForward: new Error('connection reset') });

        const response = await new Instance(fake.ctx, secrets).fetch(
          new Request('https://app.example/setup'),
        );

        expect(response.status).toBe(502);
        expect(response.headers.get('content-type')).toContain('application/json');
        expect(await failureOf(response)).toEqual({
          error: { code: 'worker_exception', step: 'forward', message: 'Error: connection reset' },
        });
      } finally {
        error.mockRestore();
      }
    });

    it('keeps answering 503 "is starting" when start() throws', async () => {
      const error = silenced();
      try {
        const { Instance } = await worker.load();
        const fake = fakeContainer();
        fake.ctx.container.start = () => {
          throw new Error('no capacity');
        };

        const response = await new Instance(fake.ctx, secrets).fetch(
          new Request('https://app.example/'),
        );

        expect(response.status).toBe(503);
        expect(await response.text()).toBe(`The ${worker.service} is starting`);
      } finally {
        error.mockRestore();
      }
    });

    it('answers 500 JSON naming the container-binding step when containers are not enabled', async () => {
      const error = silenced();
      try {
        const { Instance } = await worker.load();
        const { ctx } = fakeContainer();

        const response = await new Instance({ ...ctx, container: undefined }, secrets).fetch(
          new Request('https://app.example/'),
        );

        expect(response.status).toBe(500);
        const { error: failure } = await failureOf(response);
        expect(failure.code).toBe('worker_exception');
        expect(failure.step).toBe('container-binding');
        expect(failure.message).toContain(`${worker.className} class`);
      } finally {
        error.mockRestore();
      }
    });

    it('answers 500 JSON from the entry when the Durable Object binding is missing or its fetch throws', async () => {
      const error = silenced();
      try {
        const { entry } = await worker.load();
        const request = new Request('https://app.example/');
        const object = { fetch: () => Promise.reject(new Error('object reset')) };
        const throwing = {
          [worker.binding]: { idFromName: () => 'id', get: () => object },
        };

        const missing = await entry.fetch(request, {});
        const rejected = await entry.fetch(request, throwing);

        expect(missing.status).toBe(500);
        expect((await failureOf(missing)).error.step).toBe('durable-object-binding');
        expect(rejected.status).toBe(500);
        expect((await failureOf(rejected)).error).toEqual({
          code: 'worker_exception',
          step: 'durable-object',
          message: 'Error: object reset',
        });
      } finally {
        error.mockRestore();
      }
    });

    it('routes the entry to the one named Durable Object and returns its answer', async () => {
      const { entry } = await worker.load();
      const names: string[] = [];
      const binding = {
        idFromName: (name: string) => {
          names.push(name);
          return 'id';
        },
        get: () => ({ fetch: () => Promise.resolve(new Response('object')) }),
      };

      const response = await entry.fetch(new Request('https://app.example/'), {
        [worker.binding]: binding,
      });

      expect(await response.text()).toBe('object');
      expect(names).toEqual([worker.object]);
    });

    it('never puts an environment value in a failure body', async () => {
      const error = silenced();
      try {
        const { Instance } = await worker.load();
        const fake = fakeContainer({ failForward: new Error('boom') });
        const distinct = Object.fromEntries(
          Object.keys(secrets).map((name) => [name, `value-of-${name}`]),
        );

        const response = await new Instance(fake.ctx, distinct).fetch(
          new Request('https://app.example/'),
        );
        const body = await response.text();

        expect(response.status).toBe(502);
        for (const value of Object.values(distinct)) {
          expect(body).not.toContain(value);
        }
      } finally {
        error.mockRestore();
      }
    });
  });

  it('starts once, waits until the server listens, and renews the inactivity timeout per request', async () => {
    const { Instance } = await worker.load();
    const fake = fakeContainer({ failProbes: 2 });
    const object = new Instance(fake.ctx, secrets);

    await object.fetch(new Request('https://app.example/a'));
    await object.fetch(new Request('https://app.example/b'));

    expect(fake.started).toHaveLength(1);
    expect(fake.destroyed()).toBe(0);
    expect(
      fake.forwarded.filter((entry) => entry === `${String(worker.port)} http://container/`),
    ).toHaveLength(3);
    expect(fake.inactivity).toEqual([900_000, 900_000]);
  });

  it.each(Object.keys(secrets))(
    'answers 503 and starts no container while %s is missing or blank',
    async (name) => {
      const { Instance } = await worker.load();
      for (const value of [undefined, '', '  ']) {
        const fake = fakeContainer();
        const object = new Instance(fake.ctx, { ...secrets, [name]: value });

        const response = await object.fetch(new Request('https://app.example/'));

        expect(response.status).toBe(503);
        expect(await response.text()).toBe(`The ${worker.service} is not configured yet`);
        expect(fake.started).toEqual([]);
        expect(fake.forwarded).toEqual([]);
      }
    },
  );

  it('stops the running container and starts it with the new environment when a secret rotates', async () => {
    const { Instance } = await worker.load();
    const fake = fakeContainer();
    const [name = ''] = Object.keys(secrets);
    await new Instance(fake.ctx, secrets).fetch(new Request('https://app.example/a'));
    const first = [...fake.stored.values()];

    // A new Worker version after `wrangler secret bulk`: the same Durable Object, new bindings.
    const rotated = { ...secrets, [name]: 'rotated' };
    await new Instance(fake.ctx, rotated).fetch(new Request('https://app.example/b'));

    expect(fake.destroyed()).toBe(1);
    expect(fake.started.map(({ env }) => env[name])).toEqual([secrets[name], 'rotated']);
    expect([...fake.stored.values()]).not.toEqual(first);
    expect(JSON.stringify([...fake.stored.values()])).not.toContain('rotated');
  });

  it('keeps the running container when the environment is unchanged', async () => {
    const { Instance } = await worker.load();
    const fake = fakeContainer();
    await new Instance(fake.ctx, secrets).fetch(new Request('https://app.example/a'));
    await new Instance(fake.ctx, { ...secrets }).fetch(new Request('https://app.example/b'));

    expect(fake.destroyed()).toBe(0);
    expect(fake.started).toHaveLength(1);
  });

  it('answers 503 with retry-after, and does not start a second container, when it cannot become ready', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { Instance } = await worker.load();
      const fake = fakeContainer({ failProbes: Number.POSITIVE_INFINITY });
      const object = new Instance(fake.ctx, secrets);

      const pending = object.fetch(new Request('https://app.example/'));
      // The environment hash settles outside the fake clock; the probes start after it.
      await vi.waitFor(() => {
        expect(fake.started).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(120 * 500);
      const response = await pending;

      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('5');
      expect(await response.text()).toBe(
        `The ${worker.service} did not answer on port ${String(worker.port)} within 60 s`,
      );
      expect(fake.started).toHaveLength(1);
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it('answers 503 within the deadline when the server accepts the connection and never replies', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { Instance } = await worker.load();
      const fake = fakeContainer({ hangProbes: true });
      const pending = new Instance(fake.ctx, secrets).fetch(new Request('https://app.example/'));
      await vi.waitFor(() => {
        expect(fake.started).toHaveLength(1);
      });
      await vi.advanceTimersByTimeAsync(70_000);
      const response = await pending;

      expect(response.status).toBe(503);
      expect(await response.text()).toContain('did not answer on port');
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it('says the container exited, with the reason the runtime gives, instead of waiting out the deadline', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { Instance } = await worker.load();
      const fake = fakeContainer({
        failProbes: Number.POSITIVE_INFINITY,
        monitor: () => Promise.reject(new Error('Container exited with unexpected exit code: 1')),
      });

      const response = await new Instance(fake.ctx, secrets).fetch(
        new Request('https://app.example/'),
      );

      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('5');
      expect(await response.text()).toBe(
        `The ${worker.service} container exited (Container exited with unexpected exit code: 1)`,
      );
    } finally {
      error.mockRestore();
    }
  });

  it('routes every request to one Durable Object', async () => {
    const { entry } = await worker.load();
    const names: string[] = [];
    const env = {
      [worker.binding]: {
        idFromName: (name: string) => {
          names.push(name);
          return name;
        },
        get: () => ({ fetch: () => Promise.resolve(new Response('proxied')) }),
      },
    };

    await entry.fetch(new Request('https://app.example/a'), env);
    await entry.fetch(new Request('https://app.example/b'), env);

    expect(names).toEqual([worker.object, worker.object]);
  });
});

describe('the runner manager Worker', () => {
  it.each([
    ['cloudflare-sandbox', 'CLOUDFLARE_SANDBOX_BRIDGE_URL', 'EXTERNAL_PROVIDER'],
    ['external', 'EXTERNAL_PROVIDER', 'CLOUDFLARE_SANDBOX_BRIDGE_URL'],
  ] as const)('with driver %s also requires %s, not %s', (driver, needed, other) => {
    const profile = defaultProfile({ cloud: 'cloudflare', projectName: 'a' });
    const rendered = renderCloudflareProject({ ...profile, runtime: { default: driver } }, images);
    const module =
      rendered?.files.find(({ fileName }) => fileName === 'manager-worker.mjs')?.contents ?? '';
    const required = /const REQUIRED_SECRETS = \[([^\]]*)\]/u.exec(module)?.[1] ?? '';

    expect(required).toContain(`'${needed}'`);
    expect(required).not.toContain(`'${other}'`);
  });
});

describe('the Cloudflare frontend Worker', () => {
  it('serves the built web/ output as a single-page app after running the project build', () => {
    expect(cloudflareFrontendConfiguration('/p/web', '/p/web/dist')).toEqual({
      compatibility_date: '2026-10-01',
      workers_dev: true,
      build: { command: 'npm run build', cwd: '/p/web' },
      assets: { directory: '/p/web/dist', not_found_handling: 'single-page-application' },
    });
  });
});
