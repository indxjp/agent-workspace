import { type Allocation } from './manager-support.js';
import type { RunnerManagerOptions } from './manager-options.js';

export type ManagerContext = ReturnType<typeof createManagerContext>;

export function createManagerContext(
  options: RunnerManagerOptions,
  maxAllocationBodyBytes: number,
) {
  if (options.token.length < 32) throw new Error('runner manager token must contain 32 characters');
  const expectedToken = Buffer.from(options.token);
  const allocations = new Map<string, Allocation>();
  const bySession = new Map<string, string>();
  const sessionLocks = new Map<string, Promise<unknown>>();
  const doFetch = options.fetch ?? globalThis.fetch;
  const runtimeOrigin = options.runtimeOrigin ?? ((handle) => `http://${handle.externalId}:8080`);
  const runtimeRequestUrl =
    options.runtimeRequestUrl ??
    ((handle, requestPath) => `${runtimeOrigin(handle)}${requestPath}`);
  const expectedDriver = options.expectedDriver ?? 'docker';
  const authHeaders =
    options.runtimeAuthHeaders ?? ((): Promise<Record<string, string>> => Promise.resolve({}));
  const readinessPath = options.readinessPath ?? '/healthz';
  return {
    options,
    maxAllocationBodyBytes,
    expectedToken,
    allocations,
    bySession,
    sessionLocks,
    doFetch,
    runtimeRequestUrl,
    expectedDriver,
    authHeaders,
    readinessPath,
  };
}
