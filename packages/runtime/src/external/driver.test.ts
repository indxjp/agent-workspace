import { describe, expect, it } from 'vitest';

import type { RuntimeConfig, RuntimeRunSpec } from '../driver.js';
import {
  createExternalDriver,
  type ExternalProvider,
  type ExternalSandboxRequest,
} from './driver.js';
import { createE2bProvider } from './e2b.js';

const IMAGE = 'agent-runtime:0b6f2f0e-5a52-4f6c-9d57-2c1f8d3a7e11';

/** A provider that declares only `open`, so the shared refusal is pinned without Cloudflare. */
function openOnlyProvider() {
  const requests: ExternalSandboxRequest[] = [];
  const base = createE2bProvider();
  const provider: ExternalProvider = {
    id: 'open-only',
    capabilities: { ...base.capabilities, networkPolicies: ['open'] },
    restrictedRefusal: base.restrictedRefusal,
    create: (request) => {
      requests.push(request);
      return Promise.resolve({
        sandboxId: 'sbx1',
        origin: 'https://sbx1.example.com',
        accessHeaders: {},
      });
    },
    destroy: () => Promise.resolve(),
  };
  const driver = createExternalDriver<never, never>({
    provider,
    images: new Map([['claude-agent-sdk', IMAGE]]),
    gatewayUrl: 'https://gateway.example.com/v1',
    startAgent: () => {
      throw new Error('not used');
    },
  });
  return { driver, requests };
}

function configOf(networkPolicy?: RuntimeRunSpec['networkPolicy']): RuntimeConfig {
  return {
    engine: 'claude-agent-sdk',
    sessionId: 'session-1',
    workspacePath: '/ws/session-1',
    runtimeProfileId: 'profile-1',
    ...(networkPolicy === undefined
      ? {}
      : {
          runSpec: {
            runtimeProfileId: 'profile-1',
            driver: 'external',
            networkPolicy,
            filesystem: 'read-write',
          },
        }),
  };
}

describe('an external provider that does not declare none (ADR-0131)', () => {
  it('refuses none, and a run with no run spec, before the provider is called', async () => {
    const { driver, requests } = openOnlyProvider();
    for (const config of [configOf('none'), configOf()]) {
      await expect(driver.create(config, 'key')).rejects.toMatchObject({
        code: 'network_policy_unsupported',
      });
    }
    expect(requests).toEqual([]);
  });

  it('still passes open to the provider', async () => {
    const { driver, requests } = openOnlyProvider();
    await driver.create(configOf('open'), 'key');
    expect(requests.map((request) => request.networkPolicy)).toEqual(['open']);
  });
});

describe('an idle-bounded session sandbox', () => {
  const SEAL_SECRET = 's'.repeat(32);

  function statelessProvider() {
    const created: number[] = [];
    const renewed: Array<number | undefined> = [];
    const base = createE2bProvider();
    const provider: ExternalProvider = {
      id: 'fake',
      capabilities: { ...base.capabilities, maxSessionSeconds: 3_600 },
      restrictedRefusal: base.restrictedRefusal,
      create: (request) => {
        created.push(request.timeoutSeconds);
        return Promise.resolve({
          sandboxId: 'sbx1',
          origin: 'https://sbx1.example.com',
          accessHeaders: {},
        });
      },
      destroy: () => Promise.resolve(),
      find: (_lookupKey, _apiKey, renewSeconds) => {
        renewed.push(renewSeconds);
        return Promise.resolve({
          sandboxId: 'sbx1',
          origin: 'https://sbx1.example.com',
          accessHeaders: {},
          expiresAt: Date.now() + 60_000,
        });
      },
    };
    return { provider, created, renewed };
  }

  function driverOf(
    provider: ExternalProvider,
    options: { sessionIdleSeconds?: number; workload?: 'tool-host' } = {},
  ) {
    return createExternalDriver<never, never>({
      provider,
      images: new Map([['claude-agent-sdk', IMAGE]]),
      gatewayUrl: 'https://gateway.example.com/v1',
      startAgent: () => {
        throw new Error('not used');
      },
      sealSecret: SEAL_SECRET,
      ...options,
    });
  }

  function withSpec(spec: Partial<RuntimeRunSpec>): RuntimeConfig {
    const config = configOf('none');
    if (config.runSpec === undefined) throw new Error('the config has a run spec');
    return { ...config, runSpec: { ...config.runSpec, ...spec } };
  }

  it('creates the sandbox with the idle limit plus a margin, not the plan maximum', async () => {
    const { provider, created } = statelessProvider();
    await driverOf(provider, { sessionIdleSeconds: 900 }).create(configOf('none'), 'key');
    expect(created).toEqual([1_020]);
  });

  it('honours a longer idle timeout on the profile, and never a shorter one', async () => {
    const { provider, created } = statelessProvider();
    const driver = driverOf(provider, { sessionIdleSeconds: 900 });
    await driver.create(withSpec({ idleTimeoutSeconds: 1_800 }), 'key');
    await driver.create(withSpec({ idleTimeoutSeconds: 60 }), 'key');
    expect(created).toEqual([1_920, 1_020]);
  });

  it('caps the bound at the plan maximum', async () => {
    const { provider, created } = statelessProvider();
    await driverOf(provider, { sessionIdleSeconds: 900 }).create(
      withSpec({ idleTimeoutSeconds: 7_200 }),
      'key',
    );
    expect(created).toEqual([3_600]);
  });

  it('renews the deadline to the same bound each time the session is found', async () => {
    const { provider, renewed } = statelessProvider();
    await driverOf(provider, { sessionIdleSeconds: 900 }).find?.(configOf('none'), 'key');
    expect(renewed).toEqual([1_020]);
  });

  it('keeps a profile timeoutSeconds as a hard deadline, with no renewal', async () => {
    const { provider, created, renewed } = statelessProvider();
    const driver = driverOf(provider, { sessionIdleSeconds: 900 });
    await driver.create(withSpec({ timeoutSeconds: 600 }), 'key');
    await driver.find?.(withSpec({ timeoutSeconds: 600 }), 'key');
    expect(created).toEqual([600]);
    expect(renewed).toEqual([undefined]);
  });

  it('leaves a driver without the option on the plan maximum', async () => {
    const { provider, created, renewed } = statelessProvider();
    const driver = driverOf(provider);
    await driver.create(configOf('none'), 'key');
    await driver.find?.(configOf('none'), 'key');
    expect(created).toEqual([3_600]);
    expect(renewed).toEqual([undefined]);
  });

  it('leaves the tool host on its own deadline', async () => {
    const { provider, created, renewed } = statelessProvider();
    const driver = driverOf(provider, { sessionIdleSeconds: 900, workload: 'tool-host' });
    await driver.create(withSpec({ timeoutSeconds: 1_020 }), 'key');
    await driver.find?.(withSpec({ timeoutSeconds: 1_020 }), 'key');
    expect(created).toEqual([1_020]);
    expect(renewed).toEqual([1_020]);
    await driver.create(configOf('none'), 'key');
    expect(created[1]).toBe(3_600);
  });
});
