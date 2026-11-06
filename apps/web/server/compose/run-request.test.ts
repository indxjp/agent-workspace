import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { describe, expect, it } from 'vitest';

import type { AgentRecord } from '../agents/contract';

import { type AgentRunResourceSelection } from './resource-loader';

import { compose, MCP_KEY, member } from './run-request.fixture.test-support';
function registerAwControlAccessTests() {
  describe('buildRunRequestFor — who gets the aw-control tools (#1851 slice 2, B2)', () => {
    const NAME = 'hr-onboarding-coordinator';
    const ceiling: ProjectPolicy = { builder: { allow: [NAME] } };
    const none: AgentRunResourceSelection = { files: [], skills: [], mcpServers: {} };
    const madeByAgent = { agentId: null, version: 1, runId: 'run-1' } as const;
    const door = {
      type: 'http',
      url: 'http://gateway:4000/v1/tools/aw-control/mcp',
      headers: { authorization: 'Bearer run-token' },
    };
    const awControlOf = async (
      agent: Partial<AgentRecord>,
      ceilingForRun: ProjectPolicy | null,
      builtin?: 'builder',
    ) => {
      const { run } = await compose(none, member, undefined, builtin, {
        agent,
        ceiling: ceilingForRun,
      });
      return (await run()).portable.mcpServers['aw-control'];
    };

    it("[US-BLD-07][api][sdk] an allowed, person-made agent's run has the aw-control tools", async () => {
      expect(await awControlOf({ name: NAME }, ceiling)).toEqual(door);
    });

    it('gives the Builder the tools with no ceiling at all', async () => {
      expect(await awControlOf({ name: 'builder' }, null, 'builder')).toEqual(door);
    });

    it('does not give an allowed agent made by an agent the tools', async () => {
      expect(
        await awControlOf({ name: NAME, createdByAgent: madeByAgent }, ceiling),
      ).toBeUndefined();
    });

    it.each([
      ['an unlisted name', { name: 'other' }, ceiling],
      ['no ceiling', { name: NAME }, null],
      ['an empty allow-list', { name: NAME }, { builder: { allow: [] } }],
      ['a different case', { name: 'HR-Onboarding-Coordinator' }, ceiling],
      ['leading padding', { name: ` ${NAME}` }, ceiling],
      ['trailing padding', { name: `${NAME} ` }, ceiling],
    ] satisfies Array<[string, Partial<AgentRecord>, ProjectPolicy | null]>)(
      'does not give an agent with %s the tools',
      async (_label, agent, ceilingForRun) => {
        expect(await awControlOf(agent, ceilingForRun)).toBeUndefined();
      },
    );

    it('still refuses an allowed agent that reaches a workspace connector of that name', async () => {
      const connector: AgentRunResourceSelection = {
        ...none,
        mcpServers: { [MCP_KEY]: { type: 'http', url: 'https://mcp.example.test/mcp' } },
        connectorNames: { [MCP_KEY]: 'aw-control' },
      };
      const { run, issued } = await compose(connector, member, undefined, undefined, {
        agent: { name: NAME },
        ceiling,
      });
      await expect(run()).rejects.toMatchObject({ code: 'not_allowed_to_build' });
      expect(issued).toEqual([]);
    });
  });
}

import { registerAwControlDoorTests } from './run-request.aw-control-door.test-support';
import { registerCodeToolsTests } from './run-request.code-tools.test-support';
import { registerDailyCostCapTests } from './run-request.daily-cost-cap.test-support';
import { registerDeploymentModelTests } from './run-request.deployment-model.test-support';
import { registerFileGrantPolicyTests } from './run-request.file-grant-policy.test-support';
import { registerIdentityAssertionTests } from './run-request.identity-assertion.test-support';
import { registerModelResolutionTests } from './run-request.model-resolution.test-support';
import { registerPolicyCeilingTests } from './run-request.policy-ceiling.test-support';
import { registerPortableAgentTests } from './run-request.portable-agent.test-support';
import { registerProtocolCheckTests } from './run-request.protocol-check.test-support';
import { registerRequestBodyTests } from './run-request.request-body.test-support';
import { registerRuntimeSettingsTests } from './run-request.runtime-settings.test-support';
import { registerSandboxTests } from './run-request.sandbox.test-support';
import { registerTeamMembersTests } from './run-request.team-members.test-support';
import { registerToolConnectorsTests } from './run-request.tool-connectors.test-support';
import { registerToolHostHeadersTests } from './run-request.tool-host-headers.test-support';
import { registerToolSandboxHeadersTests } from './run-request.tool-sandbox-headers.test-support';

registerRuntimeSettingsTests();
registerSandboxTests();
registerPortableAgentTests();
registerToolHostHeadersTests();
registerFileGrantPolicyTests();
registerProtocolCheckTests();
registerRequestBodyTests();
registerToolConnectorsTests();
registerPolicyCeilingTests();
registerModelResolutionTests();
registerDeploymentModelTests();
registerCodeToolsTests();
registerToolSandboxHeadersTests();
registerDailyCostCapTests();
registerIdentityAssertionTests();
registerAwControlDoorTests();
registerAwControlAccessTests();
registerTeamMembersTests();
