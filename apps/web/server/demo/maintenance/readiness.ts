/**
 * The deploy's read-only readiness check (R2, "The GCP deployment"): whether the demo's Anthropic
 * API key is configured, and whether the Anthropic API answers a model listing with it. A listing
 * spends no tokens. The key is sent as the request's credential and is never returned or logged.
 */
import { guardedFetch, loadEgressPolicyFromEnv, type EgressResolver } from '@agent-workspace/core';

import type { DemoReadinessCheck } from '../operator';

const ANTHROPIC_API_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
/**
 * The longest the Anthropic API may take to answer before it counts as unreachable; the same bound
 * as the models probe (`models/probe.ts`), which this domain may not import.
 */
export const READINESS_TIMEOUT_MS = 10_000;

export function createDemoReadinessCheck(input: {
  readonly apiKey: string | null;
  readonly request?: typeof fetch;
  readonly timeoutMs?: number;
  /** How the egress guard resolves the API's host; the system resolver unless a test supplies one. */
  readonly resolve?: EgressResolver;
}): DemoReadinessCheck {
  const { apiKey, request = fetch, timeoutMs = READINESS_TIMEOUT_MS, resolve } = input;
  return {
    async check() {
      if (apiKey === null) return { apiKeyConfigured: false, apiReachable: false };
      try {
        const response = await guardedFetch(
          `${ANTHROPIC_API_URL}/v1/models?limit=1`,
          {
            method: 'GET',
            headers: { 'anthropic-version': ANTHROPIC_VERSION, 'x-api-key': apiKey },
            signal: AbortSignal.timeout(timeoutMs),
          },
          loadEgressPolicyFromEnv(),
          request,
          resolve,
        );
        return { apiKeyConfigured: true, apiReachable: response.ok };
      } catch {
        // Unreachable, timed out or refused by the egress policy: the answer is "not reachable".
        return { apiKeyConfigured: true, apiReachable: false };
      }
    },
  };
}
