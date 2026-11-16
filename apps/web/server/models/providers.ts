/**
 * What a model connection may claim beyond its gateway adapter, per provider (refactoring plan
 * part 08, step 5). Discovery reports an adapter's capabilities for every connection that runs on
 * it, but a capability verified live against one endpoint does not carry to another endpoint
 * speaking the same wire. A `Record` over every provider, so a new provider fails the build until
 * it says what it may claim.
 */
import type { ModelProvider } from '@indx-workspace/contracts/runs';

export interface ProviderConnectionFacts {
  /**
   * Whether this provider's connections may claim the adapter's prompt caching. `anthropic-compatible`
   * runs on the `anthropic` adapter, but prompt caching was verified live against the Anthropic API
   * only (model-providers-live.yml), not against a third-party server speaking the same wire.
   */
  readonly mayClaimPromptCaching: boolean;
}

export const PROVIDER_CONNECTION_FACTS: Readonly<Record<ModelProvider, ProviderConnectionFacts>> = {
  anthropic: { mayClaimPromptCaching: true },
  'anthropic-compatible': { mayClaimPromptCaching: false },
  openai: { mayClaimPromptCaching: true },
  'azure-openai': { mayClaimPromptCaching: true },
  'openai-compatible': { mayClaimPromptCaching: true },
  vertex: { mayClaimPromptCaching: true },
};
