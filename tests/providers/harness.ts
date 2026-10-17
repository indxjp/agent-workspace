import { OPTIONAL_PROVIDER_SCENARIOS, requiredProviderScenarios } from './scenarios.js';
import type {
  CompatibilityOutcome,
  CompatibilityReport,
  OptionalCapabilityKey,
  ProfiledModelProvider,
} from './types.js';

const OPTIONAL_CAPABILITIES = {
  thinking: 'thinking',
  'prompt-caching': 'promptCaching',
  'structured-output': 'structuredOutput',
  'context-management': 'contextManagement',
} as const satisfies Record<(typeof OPTIONAL_PROVIDER_SCENARIOS)[number], OptionalCapabilityKey>;

export async function runCompatibilitySuite(
  provider: ProfiledModelProvider,
): Promise<CompatibilityReport> {
  const outcomes: CompatibilityOutcome[] = [];

  for (const scenario of requiredProviderScenarios()) {
    try {
      outcomes.push({
        id: scenario.id,
        verdict: 'native',
        detail: await scenario.run(provider),
      });
    } catch (error) {
      outcomes.push({
        id: scenario.id,
        verdict: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const id of OPTIONAL_PROVIDER_SCENARIOS) {
    const declared = provider.compatibility?.outcomes?.[id];
    const capability = OPTIONAL_CAPABILITIES[id];
    const verdict =
      declared?.verdict ?? (provider.capabilities[capability] ? 'native' : 'unsupported');
    if (verdict === 'approximated' && !declared?.warning?.trim()) {
      outcomes.push({ id, verdict: 'failed', detail: 'approximated capability has no warning' });
      continue;
    }
    outcomes.push({
      id,
      verdict,
      detail: `declared by ModelCapabilities.${capability}`,
      ...(declared?.warning === undefined ? {} : { warning: declared.warning }),
    });
  }

  return {
    providerId: provider.id,
    outcomes,
    ok: outcomes.every((outcome) => outcome.verdict !== 'failed'),
  };
}
