import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  maximumRunDurationMs,
  runnerManagerDriverLabel,
  runtimeVerificationNetworkPolicy,
  setupRuntimeNetworkPolicy,
  storageRootsOverlap,
  unavailableRuntimeRegistryEntries,
} from './instrumentation-node';

describe('storageRootsOverlap', () => {
  const root = path.resolve('var', 'agent-workspace');

  it('refuses a shared root and nesting in either direction', async () => {
    await expect(storageRootsOverlap(root, root)).resolves.toBe(true);
    await expect(storageRootsOverlap(root, path.join(root, 'skills'))).resolves.toBe(true);
    await expect(storageRootsOverlap(path.join(root, 'skills'), root)).resolves.toBe(true);
  });

  it('allows sibling roots', async () => {
    await expect(
      storageRootsOverlap(path.join(root, 'files'), path.join(root, 'skills')),
    ).resolves.toBe(false);
  });
});

describe('runtimeVerificationNetworkPolicy', () => {
  it('preserves network-none by default and accepts Azure preview open mode', () => {
    expect(runtimeVerificationNetworkPolicy({})).toBe('none');
    expect(runtimeVerificationNetworkPolicy({ RUNTIME_VERIFICATION_NETWORK_POLICY: 'open' })).toBe(
      'open',
    );
  });

  it('rejects misspelled policy instead of silently verifying a different network mode', () => {
    expect(() =>
      runtimeVerificationNetworkPolicy({ RUNTIME_VERIFICATION_NETWORK_POLICY: 'enabled' }),
    ).toThrow(/must be one of none, restricted, or open/u);
  });
});

describe('Azure managed runtime policy', () => {
  it('creates the first ACA profile with the configured pool-wide network policy', () => {
    expect(
      setupRuntimeNetworkPolicy('aca-sessions', {
        RUNTIME_VERIFICATION_NETWORK_POLICY: 'open',
      }),
    ).toBe('open');
    expect(setupRuntimeNetworkPolicy('aca-sessions', {})).toBe('none');
    expect(setupRuntimeNetworkPolicy('docker', {})).toBe('none');
    expect(setupRuntimeNetworkPolicy('kubernetes', {})).toBe('restricted');
    expect(setupRuntimeNetworkPolicy('local', {})).toBe('open');
  });

  it('refuses unsupported ACA restricted mode during first-run setup', () => {
    expect(() =>
      setupRuntimeNetworkPolicy('aca-sessions', {
        RUNTIME_VERIFICATION_NETWORK_POLICY: 'restricted',
      }),
    ).toThrow(/requires RUNTIME_VERIFICATION_NETWORK_POLICY to be none or open/u);
  });

  it('caps ACA streaming runs below 240 seconds without changing other drivers', () => {
    expect(maximumRunDurationMs({ RUNTIME_DRIVER: 'aca-sessions' }, 300)).toBe(225_000);
    expect(maximumRunDurationMs({ RUNTIME_DRIVER: 'aca-sessions' }, 120)).toBe(108_000);
    expect(maximumRunDurationMs({ RUNTIME_DRIVER: 'docker' }, 300)).toBe(270_000);
  });
});

describe('managed runtime registry presentation', () => {
  it('labels ACA and omits its unavailable placeholder when ACA is managed', () => {
    expect(runnerManagerDriverLabel('aca-sessions')).toBe('Azure Container Apps dynamic sessions');
    expect(unavailableRuntimeRegistryEntries('aca-sessions').map(([id]) => id)).not.toContain(
      'aca-sessions',
    );
    expect(unavailableRuntimeRegistryEntries('docker').map(([id]) => id)).toContain('aca-sessions');
  });
});
