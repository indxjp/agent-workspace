import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { describe, expect, it } from 'vitest';

import { publicRunFailure } from '../runs/failures';

import {
  createAgentRunResourceLoader,
  type AgentRunResourceLoader,
  type AgentRunResourceSelection,
} from './resource-loader';

import { buildRunRequestFor, runNetworkGrant } from './run-request';
import type { createPolicyCeilingFixture } from './run-request.policy-ceiling.fixture.test-support';
import { GATEWAY, rowRunAgent, SETTINGS } from './run-request.fixture.test-support';
export function registerCompatibilityCases({
  GITHUB_KEY,
  JIRA_KEY,
  MCP_ENTRY,
  claudeArm,
  savedAgent,
  recordingGateway,
  refusalOf,
}: ReturnType<typeof createPolicyCeilingFixture>) {
  it('regression: no ceiling composes exactly the request it composed before', async () => {
    const loader: AgentRunResourceLoader = {
      load: () =>
        Promise.resolve({
          files: [],
          skills: [],
          mcpServers: { [GITHUB_KEY]: MCP_ENTRY },
          connectorNames: { [GITHUB_KEY]: 'github' },
        }),
    };
    const { context, agents } = await savedAgent(
      claudeArm(['WebFetch'], { maxTurns: 50, maxBudgetUsd: 5 }),
    );
    const gateway = recordingGateway();
    const before = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      gateway,
      {},
      undefined,
      null,
      loader,
    );
    const after = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      gateway,
      {},
      undefined,
      null,
      loader,
      undefined,
      null,
      undefined,
      undefined,
      null,
    );
    expect(after).toEqual(before);
    expect(after.portable.limits).toEqual({ maxTurns: 50, maxBudgetUsd: 5 });
  });
  it('regression: the loader receives the met permissions, so a capped unrestrictedNetwork refuses a project connector with a typed ceiling error (#125)', async () => {
    const { context, agents } = await savedAgent(null);
    const loader = createAgentRunResourceLoader({
      catalog: { forWorkspace: () => Promise.reject(new Error('unused')) },
      projectResources: {
        listFileIds: () => Promise.resolve([]),
        listMcpServerIds: () => Promise.resolve(['connector-shared']),
      },
    });
    const refusal = await refusalOf(
      buildRunRequestFor(
        context,
        await rowRunAgent(agents, context),
        SETTINGS,
        GATEWAY,
        {},
        undefined,
        null,
        loader,
        undefined,
        'a project id',
        undefined,
        undefined,
        { permissions: { unrestrictedNetwork: false } },
      ),
    );
    expect(refusal.code).toBe('policy_cannot_widen');
    expect(refusal.publicMessage).toMatch(/^policy_cannot_widen: project a project id /u);
    expect(refusal.publicMessage).toContain(
      "this deployment's policy ceiling caps permissions.unrestrictedNetwork",
    );
    // The run's failure carries the sentence, not the generic launch message.
    expect(
      publicRunFailure(refusal, {
        operation: 'prepare-request',
        publicMessage: 'The run request could not be prepared.',
        log: () => undefined,
      }),
    ).toBe(refusal.publicMessage);
  });
  describe('runNetworkGrant (ADR-0117 decision 9, #785)', () => {
    const loaderOf = (
      mcpServers: AgentRunResourceSelection['mcpServers'],
    ): AgentRunResourceLoader => ({
      load: () =>
        Promise.resolve({
          files: [],
          skills: [],
          mcpServers,
          connectorNames: { [GITHUB_KEY]: 'github', [JIRA_KEY]: 'jira' },
        }),
    });
    const grantFor = async (
      loader: AgentRunResourceLoader | undefined,
      ceiling: ProjectPolicy | null,
    ) => {
      const { context, agents } = await savedAgent(null);
      return runNetworkGrant(context, await rowRunAgent(agents, context), loader, ceiling, null);
    };

    it('reports the switch and the DNS names of remote connectors, leaving out stdio and IPs', async () => {
      const grant = await grantFor(
        loaderOf({
          [GITHUB_KEY]: { type: 'http', url: 'https://mcp.example.test/mcp' },
          [JIRA_KEY]: { type: 'sse', url: 'http://10.0.0.5:8080/sse' },
          'connector-stdio': { type: 'stdio', command: 'mcp-server', args: [] },
          'connector-v6': { type: 'http', url: 'http://[::1]:9000/mcp' },
        }),
        null,
      );
      expect(grant).toEqual({
        unrestrictedNetwork: true,
        connectorHosts: ['mcp.example.test'],
      });
    });

    it('reports no switch when the ceiling turns it off', async () => {
      const grant = await grantFor(undefined, { permissions: { unrestrictedNetwork: false } });
      expect(grant).toEqual({ unrestrictedNetwork: false, connectorHosts: [] });
    });

    it('leaves out a connector the ceiling does not list', async () => {
      const grant = await grantFor(
        loaderOf({
          [GITHUB_KEY]: { type: 'http', url: 'https://github.example.test/mcp' },
          [JIRA_KEY]: { type: 'http', url: 'https://jira.example.test/mcp' },
        }),
        { tools: ['github'] },
      );
      expect(grant.connectorHosts).toEqual(['github.example.test']);
    });
  });
}
