import { describe, expect, it } from 'vitest';

import { CONFIG, fakeClient, poolDriver } from './aca-sessions.test-support.js';

/** Run-spec fields a fixed session pool cannot honour, with the refusal each one must produce. */
const UNSUPPORTED_RUN_SPECS = [
  {
    name: 'a different driver',
    patch: { driver: 'docker' as const },
    message: /incompatible driver docker/u,
  },
  {
    name: 'restricted networking',
    patch: { networkPolicy: 'restricted' as const },
    message: /restricted network policy/u,
  },
  {
    name: 'an allowlist',
    patch: { allowedDomains: ['api.anthropic.com'] },
    message: /allowedDomains cannot be enforced/u,
  },
  {
    name: 'persistent paths',
    patch: { persistPaths: ['/workspace/output'] },
    message: /persistPaths cannot be enforced/u,
  },
  {
    name: 'a read-only filesystem',
    patch: { filesystem: 'read-only' as const },
    message: /read-only filesystem profiles cannot be enforced/u,
  },
  {
    name: 'ephemeral disk sizing',
    patch: { diskMb: 4096 },
    message: /diskMb cannot be configured or verified/u,
  },
  {
    name: 'a hard run timeout',
    patch: { timeoutSeconds: 30 },
    message: /exposes only an idle cooldown/u,
  },
  {
    name: 'unknown fixed CPU sizing',
    patch: { cpu: 1 },
    message: /pool's fixed value is unknown/u,
  },
  {
    name: 'unknown fixed memory sizing',
    patch: { memoryMb: 2048 },
    message: /pool's fixed value is unknown/u,
  },
  {
    name: 'unknown idle cooldown',
    patch: { idleTimeoutSeconds: 600 },
    message: /pool's fixed value is unknown/u,
  },
  {
    name: 'driver-specific per-run settings',
    patch: { driverConfig: { readySessionInstances: 1 } },
    message: /unsupported per-run ACA settings/u,
  },
];

describe('aca-sessions runtime run spec', () => {
  it.each(UNSUPPORTED_RUN_SPECS)(
    'rejects $name instead of weakening the profile',
    async ({ patch, message }) => {
      const { client, allocated } = fakeClient();
      const driver = poolDriver(client);
      await expect(
        driver.create({
          ...CONFIG,
          runSpec: {
            runtimeProfileId: 'profile-1',
            driver: 'aca-sessions',
            networkPolicy: 'none',
            filesystem: 'read-write',
            ...patch,
          },
        }),
      ).rejects.toThrow(message);
      expect(allocated).toHaveLength(0);
    },
  );

  it('accepts resource, cooldown, and connection constraints only when they match the pool', async () => {
    const { client, allocated } = fakeClient();
    const driver = poolDriver(client, {
      poolConfiguration: {
        cpu: 1,
        memoryMb: 2048,
        cooldownPeriodInSeconds: 600,
        runtimeConnectionId: 'aca-preview',
      },
    });
    const exactSpec = {
      runtimeProfileId: 'profile-1',
      driver: 'aca-sessions' as const,
      runtimeConnectionId: 'aca-preview',
      cpu: 1,
      memoryMb: 2048,
      networkPolicy: 'none' as const,
      filesystem: 'read-write' as const,
      idleTimeoutSeconds: 600,
    };

    await expect(driver.create({ ...CONFIG, runSpec: exactSpec })).resolves.toMatchObject({
      driver: 'aca-sessions',
    });
    expect(allocated).toHaveLength(1);

    await expect(
      driver.create({ ...CONFIG, runSpec: { ...exactSpec, memoryMb: 1024 } }),
    ).rejects.toThrow(/requested memoryMb 1024 does not match the pool's fixed value 2048/u);
    await expect(
      driver.create({ ...CONFIG, runSpec: { ...exactSpec, idleTimeoutSeconds: 300 } }),
    ).rejects.toThrow(/requested idleTimeoutSeconds 300 does not match/u);
    await expect(
      driver.create({ ...CONFIG, runSpec: { ...exactSpec, runtimeConnectionId: 'other-pool' } }),
    ).rejects.toThrow(/requested runtimeConnectionId "other-pool" does not match/u);
  });

  it('rejects a policy that disagrees with the session pool egress status', async () => {
    const { client } = fakeClient();
    const driver = poolDriver(client, {
      networkStatus: 'EgressEnabled',
    });
    await expect(
      driver.create({
        ...CONFIG,
        runSpec: {
          runtimeProfileId: 'profile-1',
          driver: 'aca-sessions',
          networkPolicy: 'none',
          filesystem: 'read-write',
        },
      }),
    ).rejects.toThrow(/pool is EgressEnabled/u);
  });
});
