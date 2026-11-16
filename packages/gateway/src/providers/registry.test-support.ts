import type { ModelConnectionConfig } from '@indx-workspace/contracts/models';

import type { RequestContext } from '../types.js';
import { createProviderRegistry, type RegisteredProviderId } from './registry.js';

export const LOCAL_ENDPOINT = 'http://localhost:9500';
export const LOCAL_V1_ENDPOINT = 'http://localhost:9600/v1';
export const RESOLVED_CREDENTIAL = 'secret-from-run-resolution';
export const SCRIPTED_MODEL_ID = 'scripted:fixture';

export const context = (
  providerId: RegisteredProviderId,
  settings: ModelConnectionConfig,
): RequestContext => ({
  providerId,
  credential: RESOLVED_CREDENTIAL,
  requestId: 'registry-test',
  settings,
});

export const providerOf = (
  id: RegisteredProviderId,
  options: Parameters<typeof createProviderRegistry>[0],
) => {
  const provider = createProviderRegistry(options).find((row) => row.id === id);
  if (provider === undefined) throw new Error(`no registry row ${id}`);
  return provider;
};

/** A minimal Anthropic message request for `model`. */
export const message = (model: string) => ({ model, max_tokens: 1, messages: [] });

/** The id of every model a discovery answer lists. */
export const modelIds = (models: readonly { readonly id: string }[]): string[] =>
  models.map((model) => model.id);
