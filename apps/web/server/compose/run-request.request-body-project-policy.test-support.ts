import { AgentPolicySchema } from '@indx-workspace/contracts/agents';
import { expect, it } from 'vitest';
import type { AgentPolicy } from '../../contracts/agents';

import { buildRunRequestFor } from './run-request';
import type { createRequestBodyFixture } from './run-request.request-body.fixture.test-support';
import {
  ALL_ON,
  GATEWAY,
  launchContext,
  rowRunAgent,
  SETTINGS,
  WORKSPACE,
} from './run-request.fixture.test-support';
export function registerProjectPolicyCases({
  noProjectResourceLoader,
  PORTABLE,
}: ReturnType<typeof createRequestBodyFixture>) {
  it('refuses a project connector for an openai-agents arm that withholds unrestrictedNetwork, even though the checkbox is on', async () => {
    const { context, agents, agentId } = await launchContext();
    const policy: AgentPolicy = {
      engine: 'openai-agents',
      withheldPermissions: ['unrestrictedNetwork'],
      skills: { mode: 'all' },
      limits: { maxTurns: null, maxBudgetUsd: null },
    };
    await agents.forWorkspace(WORKSPACE).replacePolicy(agentId, policy);
    const resourceLoader = noProjectResourceLoader({
      listFileIds: () => Promise.resolve([]),
      listMcpServerIds: () => Promise.resolve(['connector-shared']),
    });

    await expect(
      buildRunRequestFor(
        context,
        await rowRunAgent(agents, context),
        SETTINGS,
        GATEWAY,
        {},
        ALL_ON, // the checkbox floor: unrestrictedNetwork is on
        null,
        resourceLoader,
        undefined,
        'a project id',
      ),
    ).rejects.toThrow(/unrestrictedNetwork tool permission/u);
  });
  it('refuses a project file association for an openai-agents arm that withholds readFiles, even though the checkbox is on', async () => {
    const { context, agents, agentId } = await launchContext();
    const policy: AgentPolicy = {
      engine: 'openai-agents',
      withheldPermissions: ['readFiles'],
      skills: { mode: 'all' },
      limits: { maxTurns: null, maxBudgetUsd: null },
    };
    await agents.forWorkspace(WORKSPACE).replacePolicy(agentId, policy);
    const resourceLoader = noProjectResourceLoader({
      listFileIds: () => Promise.resolve(['project-file']),
      listMcpServerIds: () => Promise.resolve([]),
    });

    await expect(
      buildRunRequestFor(
        context,
        await rowRunAgent(agents, context),
        SETTINGS,
        GATEWAY,
        {},
        ALL_ON, // the checkbox floor: readFiles is on
        null,
        resourceLoader,
        undefined,
        'a project id',
      ),
    ).rejects.toThrow(/readFiles tool permission/u);
  });
  it.each([
    ['pi', { engine: 'pi', thinkingLevel: 'low', ...PORTABLE }, { thinkingLevel: 'low' }],
    ['pi without a setting', { engine: 'pi', ...PORTABLE }, {}],
    ['mastra', { engine: 'mastra', ...PORTABLE }, {}],
    [
      'openai-agents',
      { engine: 'openai-agents', reasoningEffort: 'high', parallelToolCalls: false, ...PORTABLE },
      { reasoningEffort: 'high', parallelToolCalls: false },
    ],
  ] as const)(
    'forwards the engine-native settings of a %s policy and nothing else',
    async (_name, policy, arm) => {
      const { context, agents, agentId } = await launchContext();
      await agents.forWorkspace(WORKSPACE).replacePolicy(agentId, AgentPolicySchema.parse(policy));

      const request = await buildRunRequestFor(
        context,
        await rowRunAgent(agents, context),
        SETTINGS,
        GATEWAY,
        {},
      );

      expect(request.engine).toBe(policy.engine);
      expect(request.policy).toStrictEqual(arm);
    },
  );
}
