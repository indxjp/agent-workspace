import { log as webLogger } from '../telemetry/logger';
import { describe, expect, it, vi } from 'vitest';

import { createWebRuntimeRegistry, type TestableDriverRegistry } from './registry';

const SCOPE = { workspaceId: '22222222-2222-4222-8222-222222222222' };

function registryWith(driver: Partial<TestableDriverRegistry<string, string>>) {
  const test = vi.fn<TestableDriverRegistry<string, string>['test']>(() =>
    Promise.resolve({
      driverId: 'docker',
      handle: { id: 'probe' },
      transcript: [],
      destroyed: true as const,
    }),
  );
  const registry = createWebRuntimeRegistry({
    registry: { wasVerified: () => false, test, ...driver },
    entries: [{ id: 'docker', label: 'Docker', connectionExists: true, imageReachable: true }],
    configFor: () => ({ sessionId: 's', workspacePath: '/w', engine: 'claude-agent-sdk' }),
    requestForEcho: String,
    renderEvent: String,
  });
  return { registry, test };
}

describe('renewing a lapsed Test Runtime pass (BH061-002)', () => {
  it('re-runs Test Runtime for a driver that passed before, once for runs that start together', async () => {
    const { registry, test } = registryWith({ hasPassed: () => true });
    const renewals = await Promise.all([
      registry.renew?.('docker', SCOPE),
      registry.renew?.('docker', SCOPE),
    ]);
    expect(renewals).toEqual([true, true]);
    expect(test).toHaveBeenCalledTimes(1);
    expect(test.mock.calls[0]?.[1]).toMatchObject(SCOPE);
  });

  it('never stands in for the first Test Runtime of a driver', async () => {
    const { registry, test } = registryWith({ hasPassed: () => false });
    expect(await registry.renew?.('docker', SCOPE)).toBe(false);
    expect(test).not.toHaveBeenCalled();
  });

  it('answers false, and logs why, when the re-verification fails', async () => {
    const log = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    const { registry } = registryWith({
      hasPassed: () => true,
      test: () => Promise.reject(new Error('readiness timed out')),
    });
    expect(await registry.renew?.('docker', SCOPE)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('re-verifying docker'), {
      error: new Error('readiness timed out'),
    });
    log.mockRestore();
  });
});
