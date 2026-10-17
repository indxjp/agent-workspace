import type { CompatibilityReport, CompatibilityVerdict } from './types.js';

export type EvidenceCapability = 'native' | 'approximated' | 'unsupported' | 'missing';
export type ScenarioStatus = 'passed' | 'failed' | 'skipped' | 'missing';

export function decideEvidenceMark(
  scenarioStatus: ScenarioStatus,
  capability: EvidenceCapability,
): CompatibilityVerdict;
export function renderCompatibilityMatrixWithScenarios(
  reports: readonly CompatibilityReport[],
  allScenarios: readonly string[],
): string;
