import { describe, expect, it } from 'vitest';

import { type CloudRunResourceClient } from './cloud-run.js';
import { cloudRunDriver, echoConnection, fakeClient } from './cloud-run.test-support.js';

describe('cloud-run-service runtime', () => {
  it('deploys one private service per session and reports its URL as the handle', async () => {
    const { client, created } = fakeClient();
    const driver = cloudRunDriver(client, {
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
    const driver = cloudRunDriver(client);
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
      cloudRunDriver(fakeClient().client, {
        images: new Map([['claude-agent-sdk', 'runtime:latest']]),
        requireDigest: true,
      }),
    ).toThrow(/pinned by sha256 digest/u);
  });
});

describe('cloud-run-service runtime: teardown and readiness failures', () => {
  it('destroys the exact service create() stood up and marks the handle no longer live', async () => {
    const { client, deleted } = fakeClient();
    const driver = cloudRunDriver(client);
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
      listServices: () => Promise.resolve([]),
    };
    const driver = cloudRunDriver(client, { readyTimeoutMs: 0 });
    await expect(
      driver.create({
        engine: 'claude-agent-sdk',
        sessionId: 'session-1',
        workspacePath: '/ws/session-1',
      }),
    ).rejects.toThrow(/did not become ready/u);
    expect(deleted).toHaveLength(1);
  });

  it('reports a failed rollback delete alongside the readiness failure', async () => {
    const client: CloudRunResourceClient = {
      createService: (spec) =>
        Promise.resolve({
          name: `projects/${spec.project}/locations/${spec.region}/services/${spec.serviceId}`,
          url: '',
          ready: false,
        }),
      getService: (name) => Promise.resolve({ name, url: '', ready: false }),
      deleteService: () => Promise.reject(new Error('delete denied')),
      listServices: () => Promise.resolve([]),
    };
    const driver = cloudRunDriver(client, { readyTimeoutMs: 0 });
    await expect(
      driver.create({
        engine: 'claude-agent-sdk',
        sessionId: 'session-1',
        workspacePath: '/ws/session-1',
      }),
    ).rejects.toThrow(/did not become ready.*also failed \(delete denied\)/u);
  });
});

function driver(
  client: CloudRunResourceClient,
  overrides: { network?: string; subnetwork?: string } = {},
) {
  return cloudRunDriver(client, { ...overrides });
}

describe('cloud-run-service runtime: sandbox has no internet', () => {
  it.each(['open', 'restricted'] as const)(
    'refuses the %s network policy before any service is created',
    async (networkPolicy) => {
      const { client, created } = fakeClient();
      await expect(
        driver(client).create({
          sessionId: 's',
          engine: 'claude-agent-sdk',
          workspacePath: '/ws/s',
          runSpec: {
            runtimeProfileId: 'p',
            driver: 'cloud-run-service',
            networkPolicy,
            filesystem: 'read-write',
          },
        }),
      ).rejects.toThrow(/need gcp\.sandboxInternet: true in agent-workspace\.yaml/u);
      expect(created).toHaveLength(0);
    },
  );

  it('refuses allowedDomains on the none policy without a proxy as a spec error, not a missing option', async () => {
    const { client, created } = fakeClient();
    await expect(
      driver(client).create({
        sessionId: 's',
        engine: 'claude-agent-sdk',
        workspacePath: '/ws/s',
        runSpec: {
          runtimeProfileId: 'p',
          driver: 'cloud-run-service',
          networkPolicy: 'none',
          allowedDomains: ['api.example.com'],
          filesystem: 'read-write',
        },
      }),
    ).rejects.toThrow(/applies only to the restricted/u);
    expect(created).toHaveLength(0);
  });
});

describe('cloud-run-service runtime: sandbox network construction', () => {
  it.each([{ network: '' }, { subnetwork: ' ' }])('refuses construction with %j', (overrides) => {
    expect(() => driver(fakeClient().client, overrides)).toThrow(/must be a non-empty string/u);
  });

  it('advertises only the none network policy', () => {
    expect(driver(fakeClient().client).capabilities.networkPolicies).toEqual(['none']);
  });
});
