import type { ModelProvider as ConnectionProvider } from '@indx-workspace/contracts/runs';

export const PROVIDER_IDS = [
  'anthropic',
  'openai',
  'azure-openai',
  'openai-compatible',
  'vertex',
] as const;

export type RegisteredProviderId = (typeof PROVIDER_IDS)[number];

/** The registry row that serves a connection; `anthropic-compatible` has no row of its own. */
export function registryProviderId(provider: ConnectionProvider): RegisteredProviderId {
  return provider === 'anthropic-compatible' ? 'anthropic' : provider;
}
