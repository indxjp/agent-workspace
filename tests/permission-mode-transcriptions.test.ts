/**
 * **The stored policy column takes its `permissionMode` from the one list.**
 *
 * The SDK's `PermissionMode` is written out once, as `AGENT_TOOL_PERMISSION_MODES` in
 * `packages/contracts/src/agents/tool-rules.ts`, which `tests/sdk-surface.test.ts` pins to the
 * installed `sdk.d.ts`. `AgentPolicySchema` validates `PUT /api/agents/:id/policy` against it, and
 * `packages/core/src/db/schema/agents.ts` feeds the same schema into `AgentStoredPolicy`, through
 * which every `agents.policy` row is read back. This file holds that wiring: the stored Claude
 * arm's options are the list, element for element and in order, and the stored policy accepts each
 * mode and refuses one that is not on the list.
 *
 * The stored policy is read through `@agent-workspace/core/db/unscoped`, the declared escape a
 * suite uses to reach a schema object directly (see
 * `packages/core/src/db/repositories/database-reachability.test.ts`): the public `./db` barrel
 * exports `AgentStoredPolicy` as a type only, and a type cannot be compared at run time.
 * `@indx-workspace/contracts` is a devDependency of the repository root for this file's sake.
 */
import { describe, expect, it } from 'vitest';

import { AGENT_TOOL_PERMISSION_MODES } from '@indx-workspace/contracts/agents';
import { AgentStoredPolicy } from '@agent-workspace/core/db/unscoped';

/**
 * The `permissionMode` enum inside `AgentStoredPolicy`'s Claude arm, read out of the schema rather
 * than retyped. The stored policy is a union by engine since ENG-09 (#308); `permissionMode` is the
 * Claude Agent SDK's own vocabulary and lives on that arm only.
 */
const claudeArm = AgentStoredPolicy.options[0];
const storedPolicyPermissionModes = claudeArm.shape.tools.shape.permissionMode.options;

describe('the stored policy takes its permissionMode from the contracts list', () => {
  it('reads the Claude arm of the stored policy', () => {
    expect(claudeArm.shape.engine.value).toBe('claude-agent-sdk');
  });

  it('has a non-empty list to compare against', () => {
    // ADR-0015: a check that cannot run must fail. An empty list would make the assertions below
    // pass against nothing and prove nothing.
    expect(AGENT_TOOL_PERMISSION_MODES.length).toBeGreaterThan(0);
  });

  it("matches in the agents.policy column's AgentStoredPolicy schema", () => {
    expect([...storedPolicyPermissionModes]).toEqual([...AGENT_TOOL_PERMISSION_MODES]);
  });

  it('accepts every listed mode and refuses one that is not listed', () => {
    const policyFor = (permissionMode: string): unknown => ({
      engine: 'claude-agent-sdk',
      tools: {
        base: 'claude_code_preset',
        autoApprove: [],
        deny: [],
        permissionMode,
        allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
      },
      skills: { mode: 'all' },
      limits: { maxTurns: null, maxBudgetUsd: null },
    });
    for (const mode of AGENT_TOOL_PERMISSION_MODES) {
      expect(AgentStoredPolicy.safeParse(policyFor(mode)).success, mode).toBe(true);
    }
    expect(AgentStoredPolicy.safeParse(policyFor('nonexistentMode')).success).toBe(false);
  });
});
