import { compileRunRequest } from '@agent-workspace/engine-claude-agent-sdk/testing';

import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { describe, expect, it } from 'vitest';

import type { AgentPolicy } from '../../contracts/agents';

import type { RunTeamMembers } from './run-request-tool-connectors';

import { buildRunRequestFor } from './run-request';
import {
  ALL_ON,
  GATEWAY,
  launchContext,
  rowRunAgent,
  SETTINGS,
  WORKSPACE,
} from './run-request.fixture.test-support';
export function registerTeamMembersTests() {
  describe('buildRunRequestFor — agent-team member tools (ADR-0104 acceptance, #1517)', () => {
    const TEAM: RunTeamMembers = {
      url: 'https://aw.example.test/api/runs/r/members/mcp',
      names: ['writer', 'critic'],
    };
    const PARENT = '99999999-1111-4111-8111-111111111111';

    function teamArm(deny: readonly string[]): AgentPolicy {
      return {
        engine: 'claude-agent-sdk',
        tools: {
          base: 'claude_code_preset',
          autoApprove: ['agent__writer'],
          deny: [...deny],
          permissionMode: 'default',
          allowDangerouslySkipPermissions: false,
        },
        skills: { mode: 'all' },
        limits: { maxTurns: null, maxBudgetUsd: null },
      };
    }

    /** One run composed for an agent saved with every switch on and `policy`. */
    async function composeTeamRun(
      policy: AgentPolicy,
      options: {
        readonly team?: RunTeamMembers | null;
        readonly parentRunId?: string;
        readonly ceiling?: ProjectPolicy | null;
      } = {},
    ) {
      const { context, agents, agentId } = await launchContext();
      const store = agents.forWorkspace(WORKSPACE);
      await store.update(agentId, { permissions: ALL_ON });
      await store.replacePolicy(agentId, policy);
      const run =
        options.parentRunId === undefined
          ? context.run
          : { ...context.run, parentRunId: options.parentRunId };
      const team = options.team ?? null;
      return buildRunRequestFor(
        { ...context, run, ...(team === null ? {} : { team }) },
        await rowRunAgent(agents, context),
        SETTINGS,
        GATEWAY,
        {},
        undefined,
        null,
        undefined,
        undefined,
        null,
        undefined,
        undefined,
        options.ceiling ?? null,
      );
    }

    it("gives a team's lead run exactly one `agent` server at its member endpoint, with the run token", async () => {
      const request = await composeTeamRun(teamArm([]), { team: TEAM });
      const keys = Object.keys(request.portable.mcpServers);
      expect(keys.filter((key) => key === 'agent')).toEqual(['agent']);
      expect(request.portable.mcpServers['agent']).toEqual({
        type: 'http',
        url: TEAM.url,
        headers: { authorization: `Bearer ${request.gateway?.token ?? 'missing'}` },
      });
      // A rule written against the neutral member name is in the Claude engine's spelling.
      expect(request.policy).toMatchObject({ tools: { autoApprove: ['mcp__agent__writer'] } });
    });

    it('gives a child run no `agent` server, whatever team it is handed (depth at most 1)', async () => {
      const child = await composeTeamRun(teamArm([]), { team: TEAM, parentRunId: PARENT });
      expect(Object.keys(child.portable.mcpServers)).not.toContain('agent');
      const plain = await composeTeamRun(teamArm([]));
      expect(Object.keys(plain.portable.mcpServers)).not.toContain('agent');
    });

    it("composes a member with its own policy and the ceiling, never the lead's", async () => {
      // The lead allows WebFetch; the member's own definition denies it. A member run composes from
      // its own pinned definition, so its request keeps the deny the lead's does not have.
      const ceiling: ProjectPolicy = { permissions: { runCommands: false } };
      const lead = await composeTeamRun(teamArm([]), { team: TEAM, ceiling });
      const member = await composeTeamRun(teamArm(['WebFetch']), { parentRunId: PARENT, ceiling });
      expect(compileRunRequest(lead).disallowedTools).not.toContain('WebFetch');
      expect(compileRunRequest(member).disallowedTools).toContain('WebFetch');
      // The ceiling narrows the member as it narrows every run.
      expect(member.portable.permissions.runCommands).toBe(false);
      expect(compileRunRequest(member).disallowedTools).toContain('Bash');
    });

    it("refuses a member whose tool name would be longer than the engine's limit", async () => {
      const tooLong = { ...TEAM, names: ['m'.repeat(60)] };
      await expect(composeTeamRun(teamArm([]), { team: tooLong })).rejects.toMatchObject({
        code: 'connector_tool_name_collision',
      });
    });
  });
}
