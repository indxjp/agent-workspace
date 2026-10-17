import type { ModelCapabilities, ModelProvider } from '@agent-workspace/gateway';

export type ProviderScenarioId =
  | 'basic-response'
  | 'streaming'
  | 'system-prompt'
  | 'multi-turn-conversation'
  | 'tool-call'
  | 'tool-result'
  | 'multiple-tool-calls'
  | 'errors'
  | 'usage'
  | 'cancellation'
  | 'thinking'
  | 'prompt-caching'
  | 'structured-output'
  | 'context-management';

export type CompatibilityVerdict =
  'native' | 'approximated' | 'unsupported' | 'failed' | 'unverified' | 'not-derivable';

export type CompatibilityOutcome = {
  readonly id: ProviderScenarioId;
  readonly verdict: CompatibilityVerdict;
  readonly detail: string;
  /** Required when and only when the provider approximates a capability. */
  readonly warning?: string;
};

export type CompatibilityReport = {
  readonly providerId: string;
  readonly outcomes: readonly CompatibilityOutcome[];
  readonly ok: boolean;
};

export type CompatibilityProfile = {
  readonly outcomes?: Partial<
    Record<
      Extract<
        ProviderScenarioId,
        'thinking' | 'prompt-caching' | 'structured-output' | 'context-management'
      >,
      {
        readonly verdict: 'native' | 'approximated' | 'unsupported';
        readonly warning?: string;
      }
    >
  >;
};

export type ProfiledModelProvider = ModelProvider & {
  readonly compatibility?: CompatibilityProfile;
};

export type OptionalCapabilityKey = keyof Pick<
  ModelCapabilities,
  'thinking' | 'promptCaching' | 'structuredOutput' | 'contextManagement'
>;
