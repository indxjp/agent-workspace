import { describe, expect, it, vi } from 'vitest';

import { createCloudRunDriver, type CloudRunResourceClient } from './cloud-run.js';

function echoConnection(value: string) {
  return {
    events: (async function* () {
      await Promise.resolve();
      yield value;
    })(),
    sessionId: Promise.resolve('session'),
    interrupt: () => Promise.resolve(),
  };
}

function fakeClient(): {
  client: CloudRunResourceClient;
  created: string[];
  deleted: string[];
} {
  const created: string[] = [];
  const deleted: string[] = [];
  const services = new Map<string, { ready: boolean; url: string }>();
  const client: CloudRunResourceClient = {
    createService: (spec) => {
      const name = `projects/${spec.project}/locations/${spec.region}/services/${spec.serviceId}`;
      created.push(name);
      services.set(name, { ready: false, url: '' });
      return Promise.resolve({ name, url: '', ready: false });
    },
    getService: (name) => {
      const known = services.get(name);
      if (known === undefined) return Promise.resolve(null);
      // First poll after creation reports ready, mimicking a fast-converging revision.
      services.set(name, { ready: true, url: `https://${name.split('/').pop()}.a.run.app` });
      return Promise.resolve({ name, ...services.get(name)! });
    },
    deleteService: (name) => {
      deleted.push(name);
      services.delete(name);
      return Promise.resolve();
    },
  };
  return { client, created, deleted };
}

describe('cloud-run-service runtime', () => {
  it('deploys one private service per session and reports its URL as the handle', async () => {
    const { client, created } = fakeClient();
    const driver = createCloudRunDriver<string, string>({
      images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
      project: 'proj',
      region: 'asia-northeast1',
      serviceAccount: 'runtime-sa@proj.iam.gserviceaccount.com',
      client,
      pollIntervalMs: 0,
      startAgent: (runtime, request) => echoConnection(`${runtime.externalId}:${request}`),
    });
    const handle = await driver.create({
      engine: 'claude-agent-sdk',
      sessionId: 'session-1',
      workspacePath: '/ws/session-1',
    });
    expect(handle.driver).toBe('cloud-run-service');
    expect(handle.externalId).toMatch(/^https:\/\/.+\.a\.run\.app$/u);
    expect(created).toHaveLength(1);
    expect(await driver.isLive(handle)).toBe(true);

    const connection = await driver.startAgent(handle, 'request');
    const events: string[] = [];
    for await (const event of connection.events) events.push(event);
    expect(events).toEqual([`${handle.externalId}:request`]);
  });

  it('refuses a run spec selecting a different driver', async () => {
    const { client } = fakeClient();
    const driver = createCloudRunDriver<string, string>({
      images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
      project: 'proj',
      region: 'asia-northeast1',
      serviceAccount: 'runtime-sa@proj.iam.gserviceaccount.com',
      client,
      startAgent: () => echoConnection('unused'),
    });
    await expect(
      driver.create({
        sessionId: 'session-1',
        engine: 'claude-agent-sdk',
        workspacePath: '/ws/session-1',
        runSpec: {
          runtimeProfileId: 'profile-1',
          driver: 'docker',
          networkPolicy: 'none',
          filesystem: 'read-write',
        },
      }),
    ).rejects.toThrow(/incompatible driver docker/u);
  });

  it('refuses production images that are not pinned by digest', () => {
    expect(() =>
      createCloudRunDriver<string, string>({
        images: new Map([['claude-agent-sdk', 'runtime:latest']]),
        project: 'proj',
        region: 'asia-northeast1',
        serviceAccount: 'runtime-sa@proj.iam.gserviceaccount.com',
        requireDigest: true,
        client: fakeClient().client,
        startAgent: () => echoConnection('unused'),
      }),
    ).toThrow(/pinned by sha256 digest/u);
  });

  it('destroys the exact service create() stood up and marks the handle no longer live', async () => {
    const { client, deleted } = fakeClient();
    const driver = createCloudRunDriver<string, string>({
      images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
      project: 'proj',
      region: 'asia-northeast1',
      serviceAccount: 'runtime-sa@proj.iam.gserviceaccount.com',
      client,
      pollIntervalMs: 0,
      startAgent: () => echoConnection('unused'),
    });
    const handle = await driver.create({
      engine: 'claude-agent-sdk',
      sessionId: 'session-1',
      workspacePath: '/ws/session-1',
    });
    await driver.destroy(handle);
    expect(deleted).toEqual([`projects/proj/locations/asia-northeast1/services/rt-${handle.id}`]);
    expect(await driver.isLive(handle)).toBe(false);
    await expect(driver.destroy(handle)).rejects.toThrow(/no longer live/u);
  });

  it('deletes the service and refuses to leave it running if it never becomes ready', async () => {
    const deleted: string[] = [];
    const client: CloudRunResourceClient = {
      createService: (spec) =>
        Promise.resolve({
          name: `projects/${spec.project}/locations/${spec.region}/services/${spec.serviceId}`,
          url: '',
          ready: false,
        }),
      getService: (name) => Promise.resolve({ name, url: '', ready: false }),
      deleteService: (name) => {
        deleted.push(name);
        return Promise.resolve();
      },
    };
    const driver = createCloudRunDriver<string, string>({
      images: new Map([['claude-agent-sdk', 'runtime@sha256:abc']]),
      project: 'proj',
      region: 'asia-northeast1',
      serviceAccount: 'runtime-sa@proj.iam.gserviceaccount.com',
      client,
      pollIntervalMs: 0,
      readyTimeoutMs: 0,
      startAgent: () => echoConnection('unused'),
    });
    await expect(
      driver.create({
        engine: 'claude-agent-sdk',
        sessionId: 'session-1',
        workspacePath: '/ws/session-1',
      }),
    ).rejects.toThrow(/did not become ready/u);
    expect(deleted).toHaveLength(1);
  });
});

describe('createCloudRunAdminClient', () => {
  it('sends a bearer token and rejects a non-2xx create response', async () => {
    const { createCloudRunAdminClient } = await import('./cloud-run.js');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const doFetch = vi.fn<typeof fetch>((url, init = {}) => {
      const href = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
      calls.push({ url: href, init });
      return Promise.resolve(new Response('forbidden', { status: 403 }));
    });
    const client = createCloudRunAdminClient({
      fetch: doFetch,
      accessToken: () => Promise.resolve('tok'),
    });
    await expect(
      client.createService({
        serviceId: 'rt-1',
        image: 'runtime@sha256:abc',
        region: 'asia-northeast1',
        project: 'proj',
        serviceAccount: 'sa@proj.iam.gserviceaccount.com',
        egress: 'none',
        labels: {},
      }),
    ).rejects.toThrow(/create service rt-1 failed: 403/u);
    expect(calls[0]?.url).toContain(
      'projects/proj/locations/asia-northeast1/services?serviceId=rt-1',
    );
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer tok');
  });
});

// ENG-07 (#306, ADR-0073 D3): the image is the run's engine's, from a map of two engines.
const TWO_ENGINE_IMAGES = new Map([
  ['claude-agent-sdk', `registry.example/runtime-claude-agent-sdk@sha256:${'a'.repeat(64)}`],
  ['pi', `registry.example/runtime-pi@sha256:${'b'.repeat(64)}`],
]);

describe('cloud-run-service runtime: one image per engine (ENG-07)', () => {
  function recordingClient(images: string[]): CloudRunResourceClient {
    return {
      createService: (spec) => {
        images.push(spec.image);
        const name = `projects/${spec.project}/locations/${spec.region}/services/${spec.serviceId}`;
        return Promise.resolve({ name, url: `https://${spec.serviceId}.a.run.app`, ready: true });
      },
      getService: (name) =>
        Promise.resolve({
          name,
          url: `https://${name.split('/').pop() ?? ''}.a.run.app`,
          ready: true,
        }),
      deleteService: () => Promise.resolve(),
    };
  }

  function driverWith(images: string[]) {
    return createCloudRunDriver<string, string>({
      images: TWO_ENGINE_IMAGES,
      project: 'proj',
      region: 'asia-northeast1',
      serviceAccount: 'runtime-sa@proj.iam.gserviceaccount.com',
      client: recordingClient(images),
      pollIntervalMs: 0,
      startAgent: (runtime, request) => echoConnection(`${runtime.externalId}:${request}`),
    });
  }

  it("deploys each run's service from its own engine's image", async () => {
    for (const engine of ['claude-agent-sdk', 'pi']) {
      const images: string[] = [];
      await driverWith(images).create({ engine, sessionId: 's', workspacePath: `/ws/${engine}` });
      expect(images).toEqual([TWO_ENGINE_IMAGES.get(engine)]);
    }
  });

  it('refuses an engine with no image before any service is deployed', async () => {
    const images: string[] = [];
    await expect(
      driverWith(images).create({
        engine: 'openai-agents',
        sessionId: 's',
        workspacePath: '/ws/x',
      }),
    ).rejects.toThrow(/no runtime image for engine "openai-agents"/u);
    expect(images).toHaveLength(0);
  });
});
