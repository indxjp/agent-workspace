import { describe, expect, it, vi } from 'vitest';

import type { CloudRunResourceClient } from './cloud-run.js';
import { cloudRunDriver, cloudRunToolDriver, fakeClient } from './cloud-run.test-support.js';

const IMAGES = new Map([['tool-host', 'tool-host@sha256:abc']]);
const CONFIG = { engine: 'tool-host', sessionId: 'session-1', workspacePath: '/ws/s1' };

type DriverOverrides = Parameters<typeof cloudRunDriver>[1];
const identityToken = vi.fn((audience: string) => Promise.resolve(`id-token-for-${audience}`));

function toolDriver(client: CloudRunResourceClient, extra: DriverOverrides = {}) {
  return cloudRunDriver(client, { images: IMAGES, serviceIdPrefix: 'rt-tool-', ...extra });
}
function intakeDriver(client: CloudRunResourceClient, extra: DriverOverrides = {}) {
  return cloudRunToolDriver(client, {
    images: IMAGES,
    serviceIdPrefix: 'rt-tool-',
    ...extra,
    fileIntake: { identityToken },
  });
}

describe('cloud-run-service runtime: tool-host file intake (ADR-0118 TS4)', () => {
  it('has no find or destroyTagged without fileIntake, so the manager keeps its session table', () => {
    const { client } = fakeClient();
    const agent = toolDriver(client);
    expect('find' in agent).toBe(false);
    expect('destroyTagged' in agent).toBe(false);
    const tool = intakeDriver(client);
    expect(typeof tool.find).toBe('function');
    expect(typeof tool.destroyTagged).toBe('function');
  });

  it('uses the prefix in create, destroy and isLive', async () => {
    const { client, specs, deleted } = fakeClient();
    const getService = vi.spyOn(client, 'getService');
    const driver = toolDriver(client);
    const handle = await driver.create(CONFIG);
    expect(specs[0]?.serviceId).toBe(`rt-tool-${handle.id}`);
    getService.mockClear();
    await driver.isLive(handle);
    expect(getService.mock.calls[0]?.[0]).toBe(
      `projects/proj/locations/asia-northeast1/services/rt-tool-${handle.id}`,
    );
    await driver.destroy(handle);
    expect(deleted).toEqual([
      `projects/proj/locations/asia-northeast1/services/rt-tool-${handle.id}`,
    ]);
  });

  it('refuses a prefix the runner IAM condition would not cover', () => {
    const { client } = fakeClient();
    expect(() => toolDriver(client, { serviceIdPrefix: 'x-' })).toThrow(/rt-/u);
  });
});

describe('cloud-run-service runtime: tool-host intake environment', () => {
  it('puts AW_TOOL_INTAKE_KEY in the env only with fileIntake', async () => {
    const plain = fakeClient();
    await toolDriver(plain.client).create(CONFIG);
    expect(plain.specs[0]?.env).toBeUndefined();

    const withIntake = fakeClient();
    await toolDriver(withIntake.client, { fileIntake: { identityToken } }).create(CONFIG);
    expect(withIntake.specs[0]?.env?.['AW_TOOL_INTAKE_KEY']).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(withIntake.specs[0]?.minInstances).toBe(1);
    expect(plain.specs[0]?.minInstances).toBeUndefined();
  });

  it('points the tool host at a writable directory, since Cloud Run mounts no /workspace', async () => {
    const plain = fakeClient();
    await toolDriver(plain.client).create(CONFIG);
    expect(plain.specs[0]?.env?.['TOOL_HOST_DIR']).toBeUndefined();

    const withIntake = fakeClient();
    await toolDriver(withIntake.client, { fileIntake: { identityToken } }).create(CONFIG);
    expect(withIntake.specs[0]?.env?.['TOOL_HOST_DIR']).toBe('/tmp/tool-host');
  });

  it('does not pin a tool host to one request at a time', async () => {
    const { client, specs } = fakeClient();
    await toolDriver(client, { fileIntake: { identityToken } }).create(CONFIG);
    expect(specs[0]?.maxRequestConcurrency).toBeGreaterThan(1);
  });
});

describe('cloud-run-service runtime: tool-host sandbox reuse', () => {
  it('lets a second manager find and remove the first manager sandbox', async () => {
    const { client, deleted } = fakeClient();
    const first = intakeDriver(client);
    const config = { ...CONFIG, runtimeProfileId: 'tool-sandbox:s:k' };
    const created = await first.create(config, undefined, { awSessionKey: 'profile:s' });
    const second = intakeDriver(client);
    const found = await second.find(config);
    expect(found?.id).toBe(created.id);
    expect(await second.find({ ...config, runtimeProfileId: 'other' })).toBeUndefined();
    await second.destroyTagged({ awSessionKey: 'other' });
    expect(deleted).toEqual([]);
    await second.destroyTagged({ awSessionKey: 'profile:s' });
    expect(deleted).toEqual([
      `projects/proj/locations/asia-northeast1/services/rt-tool-${created.id}`,
    ]);
    expect(await second.find(config)).toBeUndefined();
  });

  it('does not reuse a sandbox whose lifetime label has passed or leaves no room for a run', async () => {
    const { client } = fakeClient();
    let clock = 1_000_000;
    const driver = intakeDriver(client, { now: () => clock });
    const config = {
      ...CONFIG,
      runtimeProfileId: 'tool-sandbox:s:k',
      runSpec: {
        runtimeProfileId: 'tool-sandbox',
        driver: 'cloud-run-service' as const,
        networkPolicy: 'none' as const,
        filesystem: 'read-write' as const,
        timeoutSeconds: 600,
      },
    };
    const created = await driver.create(config);
    expect((await driver.find(config))?.id).toBe(created.id);
    clock += 500_000;
    expect(await driver.find(config)).toBeUndefined();
    const bare = { ...CONFIG, runtimeProfileId: 'tool-sandbox:s:k' };
    expect(await driver.find(bare)).toBeDefined();
    clock += 500_000;
    expect(await driver.find(bare)).toBeUndefined();
  });

  it('deletes a sandbox past its lifetime when the next one starts', async () => {
    const { client, deleted } = fakeClient();
    let clock = 1_000_000;
    const driver = intakeDriver(client, { now: () => clock });
    const old = await driver.create({
      ...CONFIG,
      runSpec: {
        runtimeProfileId: 'tool-sandbox',
        driver: 'cloud-run-service',
        networkPolicy: 'none',
        filesystem: 'read-write',
        timeoutSeconds: 600,
      },
    });
    clock += 601_000;
    await driver.create(CONFIG);
    expect(deleted).toEqual([`projects/proj/locations/asia-northeast1/services/rt-tool-${old.id}`]);
  });
});

describe('cloud-run-service runtime: tool-host file upload', () => {
  it('PUTs the file with the ID token and the intake key', async () => {
    const { client, specs } = fakeClient();
    const driver = toolDriver(client, { fileIntake: { identityToken } });
    const handle = await driver.create(CONFIG);
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await driver.writeFile(handle, 'manifest.json', '{"a":1}');
    } finally {
      vi.unstubAllGlobals();
    }
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${handle.externalId}/files/manifest.json`);
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe('{"a":1}');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-serverless-authorization')).toBe(
      `Bearer id-token-for-${handle.externalId}`,
    );
    expect(headers.get('x-aw-tool-intake')).toBe(specs[0]?.env?.['AW_TOOL_INTAKE_KEY']);
    expect(init?.redirect).toBe('error');
  });

  it('throws on 401 naming the status and never the key or the body', async () => {
    const { client, specs } = fakeClient();
    const driver = toolDriver(client, { fileIntake: { identityToken } });
    const handle = await driver.create(CONFIG);
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => Promise.resolve(new Response('secret-body', { status: 401 }))),
    );
    try {
      const failure = await driver.writeFile(handle, 'tokens.json', '[]').catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain('401');
      expect(message).not.toContain(specs[0]?.env?.['AW_TOOL_INTAKE_KEY'] ?? 'missing');
      expect(message).not.toContain('secret-body');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('cloud-run-service runtime: tool-host intake keys', () => {
  it('refuses writeFile on an unknown handle and without fileIntake', async () => {
    const { client } = fakeClient();
    const driver = toolDriver(client, { fileIntake: { identityToken } });
    const stranger = {
      id: 'nope',
      driver: 'cloud-run-service' as const,
      externalId: 'https://x.a.run.app',
      workspacePath: '/w',
      createdAt: new Date(),
    };
    await expect(driver.writeFile(stranger, 'manifest.json', '{}')).rejects.toThrow(/not created/u);
    const bare = toolDriver(client);
    const handle = await bare.create(CONFIG);
    await expect(bare.writeFile(handle, 'manifest.json', '{}')).rejects.toThrow(/fileIntake/u);
  });

  it('forgets the key on destroy', async () => {
    const { client } = fakeClient();
    const driver = toolDriver(client, { fileIntake: { identityToken } });
    const handle = await driver.create(CONFIG);
    await driver.destroy(handle);
    await expect(driver.writeFile(handle, 'manifest.json', '{}')).rejects.toThrow(/not created/u);
  });
});
