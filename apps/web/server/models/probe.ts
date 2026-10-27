import { log } from '../telemetry/logger';
import { guardedFetch, loadEgressPolicyFromEnv } from '@agent-workspace/core';

import type { ResolvedModelConnection } from './store';
import { InfrastructureError } from '../errors';

export type TestConnectionResult = {
  readonly ok: boolean;
  readonly status: number | null;
  readonly latencyMs: number;
  readonly message: string;
};

function endpoint(resolved: ResolvedModelConnection): { url: string; headers: HeadersInit } {
  const { connection, credential } = resolved;
  const base = connection.config.baseUrl?.replace(/\/$/, '');
  switch (connection.provider) {
    case 'anthropic':
    case 'anthropic-compatible':
      return {
        url: `${base ?? 'https://api.anthropic.com'}/v1/models`,
        headers: { 'anthropic-version': '2023-06-01', 'x-api-key': credential },
      };
    case 'openai':
      return {
        url: `${base ?? 'https://api.openai.com/v1'}/models`,
        headers: { authorization: `Bearer ${credential}` },
      };
    case 'openai-compatible':
      if (base === undefined)
        throw new Error('OpenAI-compatible connections require config.baseUrl.');
      return { url: `${base}/models`, headers: { authorization: `Bearer ${credential}` } };
    case 'azure-openai': {
      if (base === undefined || connection.config.apiVersion === undefined) {
        throw new Error('Azure OpenAI connections require config.baseUrl and config.apiVersion.');
      }
      const query = new URLSearchParams({ 'api-version': connection.config.apiVersion });
      return {
        url: `${base}/openai/deployments?${query.toString()}`,
        headers: { 'api-key': credential },
      };
    }
  }
}

/**
 * How long one probe may take before it is abandoned as unreachable (issue #415): first-run setup
 * waits on it, and a provider that never answers must not hold that request open.
 */
export const PROBE_TIMEOUT_MS = 10_000;

export async function probeModelConnection(
  resolved: ResolvedModelConnection,
  request: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<TestConnectionResult> {
  const started = performance.now();
  try {
    const target = endpoint(resolved);
    const response = await guardedFetch(
      target.url,
      { method: 'GET', headers: target.headers, signal: AbortSignal.timeout(timeoutMs) },
      loadEgressPolicyFromEnv(),
      request,
    );
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      message: response.ok
        ? 'Connection succeeded.'
        : `Provider at ${new URL(target.url).host} returned HTTP ${String(response.status)}.`,
    };
  } catch (error) {
    const failure = new InfrastructureError({
      component: 'models',
      operation: 'probe-connection',
      failureKind: 'upstream',
      retryable: true,
      cause: error,
    });
    log.error('[models] provider connection probe failed', { error: failure });
    return {
      ok: false,
      status: null,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      message: 'The provider connection could not be reached.',
    };
  }
}
