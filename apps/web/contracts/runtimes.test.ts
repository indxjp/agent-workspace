import { describe, expect, it } from 'vitest';

import { defaultRuntimeNetworkPolicy } from './runtimes';

describe('defaultRuntimeNetworkPolicy', () => {
  it('defaults Cloud Run and Docker to none when the default profile provisions no proxy', () => {
    expect(defaultRuntimeNetworkPolicy('cloud-run-service')).toBe('none');
    expect(defaultRuntimeNetworkPolicy('docker')).toBe('none');
  });

  it('uses the strongest supported default for local and Kubernetes runtimes', () => {
    expect(defaultRuntimeNetworkPolicy('local')).toBe('open');
    expect(defaultRuntimeNetworkPolicy('kubernetes')).toBe('restricted');
  });
});
