import type { createAgentVersionFixture } from './agent-versions.fixture.test-support.js';
import { registerOwnershipCases } from './agent-versions.ownership.test-support.js';
import { registerRuntimeDefaultsCases } from './agent-versions.runtime-defaults.test-support.js';
import { registerCreationQuotaCases } from './agent-versions.creation-quota.test-support.js';
export function registerOwnershipRuntimeCases(
  fixture: ReturnType<typeof createAgentVersionFixture>,
) {
  registerOwnershipCases(fixture);
  registerRuntimeDefaultsCases(fixture);
  registerCreationQuotaCases(fixture);
}
