export { runCompatibilitySuite } from './harness.js';
export { decideEvidenceMark, renderCompatibilityMatrix } from './renderer.js';
export { OPTIONAL_PROVIDER_SCENARIOS, REQUIRED_PROVIDER_SCENARIOS } from './scenarios.js';
export {
  readProviderScenarioInventory,
  readProviderScenarioInventoryFromSpec,
} from './spec-scenarios.js';
export type {
  CompatibilityOutcome,
  CompatibilityProfile,
  CompatibilityReport,
  CompatibilityVerdict,
  ProfiledModelProvider,
  ProviderScenarioId,
} from './types.js';
