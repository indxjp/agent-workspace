import {
  decideEvidenceMark as decideEvidenceMarkImplementation,
  renderCompatibilityMatrixWithScenarios,
} from './renderer.mjs';
import { OPTIONAL_PROVIDER_SCENARIOS, REQUIRED_PROVIDER_SCENARIOS } from './scenarios.js';
import type { CompatibilityReport, CompatibilityVerdict } from './types.js';

const ALL_SCENARIOS = [...REQUIRED_PROVIDER_SCENARIOS, ...OPTIONAL_PROVIDER_SCENARIOS] as const;

export type EvidenceCapability = 'native' | 'approximated' | 'unsupported' | 'missing';

/** A positive scenario result is the only route to a positive matrix mark. */
export function decideEvidenceMark(
  scenarioStatus: 'passed' | 'failed' | 'skipped' | 'missing',
  capability: EvidenceCapability,
): CompatibilityVerdict {
  return decideEvidenceMarkImplementation(scenarioStatus, capability);
}

export function renderCompatibilityMatrix(reports: readonly CompatibilityReport[]): string {
  return renderCompatibilityMatrixWithScenarios(reports, ALL_SCENARIOS);
}
