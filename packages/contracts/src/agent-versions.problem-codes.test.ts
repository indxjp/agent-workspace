import { describe, expect, expectTypeOf, it } from 'vitest';
import { AGENT_VERSION_PROBLEM_CODES, type AgentVersionProblemCode } from './agent-versions.js';
import { AGENT_DEFINITION_PROBLEM_CODES, AGENT_POLICY_PROBLEM_CODES } from './agents.js';
import { RUN_START_PROBLEM_CODES } from './runs.js';

describe('AGENT_VERSION_PROBLEM_CODES: statuses', () => {
  it('maps every code to its status', () => {
    expect(AGENT_VERSION_PROBLEM_CODES).toEqual({
      invalid_agent_id: 400,
      invalid_agent_version: 400,
      unsupported_engine: 400,
      dangerous_permission_mode_refused: 400,
      agent_not_found: 404,
      agent_policy_not_configured: 503,
      agent_archived: 409,
      agent_version_not_found: 404,
      agent_version_number_taken: 409,
      no_pointer: 409,
      nothing_to_roll_back: 409,
      pointer_moved: 409,
      promotion_not_evaluated: 409,
      promotion_gate_failed: 409,
      code_tool_needs_host: 422,
      network_policy_unsupported: 422,
      stdio_connector_needs_tool_sandbox: 422,
      tool_bundle_unknown: 422,
      tool_bundles_not_configured: 503,
      agent_definition_references_missing: 422,
      agent_definition_reference_ambiguous: 409,
      agent_subagent_unusable: 422,
      engine_capability_unsupported: 422,
      engine_switch_would_widen: 422,
      policy_cannot_widen: 403,
      surface_name_taken: 409,
      agent_name_conflict: 409,
      unknown_file: 400,
      unknown_skill: 400,
      skill_deleting: 409,
      unknown_connector: 400,
      storage_connection_prefix_not_allowed: 403,
      storage_connection_write_not_allowed: 403,
    });
  });
});

describe('AGENT_VERSION_PROBLEM_CODES: reused statuses', () => {
  it('keeps each reused status equal to its source table', () => {
    expect(AGENT_VERSION_PROBLEM_CODES.unsupported_engine).toBe(
      AGENT_POLICY_PROBLEM_CODES.unsupported_engine,
    );
    expect(AGENT_VERSION_PROBLEM_CODES.dangerous_permission_mode_refused).toBe(
      AGENT_POLICY_PROBLEM_CODES.dangerous_permission_mode_refused,
    );
    expect(AGENT_VERSION_PROBLEM_CODES.agent_not_found).toBe(
      AGENT_POLICY_PROBLEM_CODES.agent_not_found,
    );
    expect(AGENT_VERSION_PROBLEM_CODES.agent_policy_not_configured).toBe(
      AGENT_POLICY_PROBLEM_CODES.agent_policy_not_configured,
    );
    expect(AGENT_VERSION_PROBLEM_CODES.engine_capability_unsupported).toBe(
      AGENT_POLICY_PROBLEM_CODES.engine_capability_unsupported,
    );
    expect(AGENT_VERSION_PROBLEM_CODES.engine_switch_would_widen).toBe(
      AGENT_POLICY_PROBLEM_CODES.engine_switch_would_widen,
    );
    expect(AGENT_VERSION_PROBLEM_CODES.policy_cannot_widen).toBe(
      AGENT_POLICY_PROBLEM_CODES.policy_cannot_widen,
    );
    expect(AGENT_VERSION_PROBLEM_CODES.agent_definition_references_missing).toBe(
      AGENT_DEFINITION_PROBLEM_CODES.agent_definition_references_missing,
    );
    expect(AGENT_VERSION_PROBLEM_CODES.agent_definition_reference_ambiguous).toBe(
      AGENT_DEFINITION_PROBLEM_CODES.agent_definition_reference_ambiguous,
    );
    expect(AGENT_VERSION_PROBLEM_CODES.agent_archived).toBe(RUN_START_PROBLEM_CODES.agent_archived);
    expectTypeOf<'agent_archived'>().toExtend<AgentVersionProblemCode>();
  });
});
