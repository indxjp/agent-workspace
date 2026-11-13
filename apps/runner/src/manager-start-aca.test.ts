import { type RuntimeHandle } from '@agent-workspace/runtime/driver';
import { expect, it } from 'vitest';
import { acaSessionsDriverOptions, acaSessionsNetworkStatus } from './manager-start.js';
import { TOKEN } from './manager-start.fixture.test-support.js';

it('runner manager ACA composition > maps the Azure pool contract to a managed runtime whose every URL carries its identifier', () => {
  const options = acaSessionsDriverOptions({
    RUNTIME_DRIVER: 'aca-sessions',
    RUNNER_MANAGER_TOKEN: TOKEN,
    ACA_SESSION_POOL_ENDPOINT: 'https://pool.westeurope.azurecontainerapps.io/subscriptions/pool',
    ACA_SESSION_POOL_API_VERSION: '2025-02-02-preview',
    ACA_SESSION_POOL_NETWORK_STATUS: 'EgressEnabled',
  });
  const handle: RuntimeHandle = {
    id: 'handle-one',
    driver: 'aca-sessions',
    externalId: 'aw-1234567890abcdef',
    workspacePath: '/workspace',
    createdAt: new Date('2026-09-11T00:00:00.000Z'),
  };

  expect(options.expectedDriver).toBe('aca-sessions');
  expect(options.readinessPath).toBe('/ping');
  expect(options.configurationFingerprint).toContain('EgressEnabled');
  const url = new URL(options.runtimeRequestUrl!(handle, '/files?path=README.md'));
  expect(url.pathname.endsWith('/subscriptions/pool/files')).toBe(true);
  expect(url.searchParams.get('path')).toBe('README.md');
  expect(url.searchParams.get('identifier')).toBe(handle.externalId);
});

it('runner manager ACA composition > defaults the pool engine to claude-agent-sdk, as ADR-0073 D6 states', () => {
  const options = acaSessionsDriverOptions({
    RUNNER_MANAGER_TOKEN: TOKEN,
    ACA_SESSION_POOL_ENDPOINT: 'https://pool.westeurope.azurecontainerapps.io/subscriptions/pool',
  });
  expect(options.configurationFingerprint?.endsWith(':claude-agent-sdk')).toBe(true);
});

it('runner manager ACA composition > defaults to no egress and rejects unknown pool network states', () => {
  expect(acaSessionsNetworkStatus({})).toBe('EgressDisabled');
  expect(() => acaSessionsNetworkStatus({ ACA_SESSION_POOL_NETWORK_STATUS: 'open' })).toThrow(
    /must be EgressEnabled or EgressDisabled/u,
  );
});
