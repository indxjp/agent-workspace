import { describe, expect, it } from 'vitest';

import { type AgentRunResourceSelection } from './resource-loader';

import {
  apiKey,
  compose,
  MCP_KEY,
  member,
  optedInMcp,
  optedInTool,
  TOOL_ID,
} from './run-request.fixture.test-support';
export function registerAwControlDoorTests() {
  describe('buildRunRequestFor — the aw-control door (#1846)', () => {
    const mcp = (name: string): AgentRunResourceSelection => ({
      files: [],
      skills: [],
      mcpServers: { [MCP_KEY]: { type: 'http', url: 'https://mcp.example.test/mcp' } },
      connectorNames: { [MCP_KEY]: name },
    });
    const tool = (name: string): AgentRunResourceSelection => ({
      ...optedInTool,
      toolConnectors: [{ key: 'orders', name, connectorId: TOOL_ID, operationNames: ['getOrder'] }],
    });

    it.each([
      'aw-control',
      'AW-Control',
      'AW-CONTROL',
      ' aw-control ',
      '\taw-control',
      'aw-control\n',
    ])(
      'refuses a run that reaches the connector name %j before a token is issued',
      async (name) => {
        for (const resources of [mcp(name), tool(name)]) {
          const { run, issued } = await compose(resources, member);
          await expect(run()).rejects.toMatchObject({ code: 'not_allowed_to_build' });
          expect(issued).toEqual([]);
        }
      },
    );

    it.each([
      [
        'an MCP server key',
        {
          files: [],
          skills: [],
          mcpServers: { 'AW-Control': { type: 'http', url: 'https://mcp.example.test/mcp' } },
          connectorNames: { 'AW-Control': 'crm' },
        },
      ],
      [
        'a tool connector key',
        {
          ...optedInTool,
          toolConnectors: [
            {
              key: '\taw-control',
              name: 'orders',
              connectorId: TOOL_ID,
              operationNames: ['getOrder'],
            },
          ],
        },
      ],
    ] satisfies Array<[string, AgentRunResourceSelection]>)(
      'refuses %s equal to the reserved name, whatever the connector is called',
      async (_label, resources) => {
        const { run, issued } = await compose(resources, member);
        await expect(run()).rejects.toMatchObject({ code: 'not_allowed_to_build' });
        expect(issued).toEqual([]);
      },
    );

    it.each(['aw-control-2', 'aw_control', 'aw-dev-tools'])(
      'leaves the connector %j alone',
      async (name) => {
        const { run, issued } = await compose(mcp(name), member);
        await run();
        expect(issued).toHaveLength(1);
      },
    );

    it.each(['aw-control', 'AW-CONTROL', '\taw-control\n'])(
      'refuses a Builder run that selects the workspace connector %j',
      async (name) => {
        const { run, issued } = await compose(mcp(name), member, undefined, 'builder');
        await expect(run()).rejects.toMatchObject({ code: 'not_allowed_to_build' });
        expect(issued).toEqual([]);
      },
    );

    it('refuses the reserved name before asking for an identity the run has no caller for', async () => {
      const resources: AgentRunResourceSelection = {
        ...optedInMcp,
        connectorNames: { [MCP_KEY]: 'aw-control' },
      };
      const { run, issued } = await compose(resources, apiKey);
      await expect(run()).rejects.toMatchObject({ code: 'not_allowed_to_build' });
      expect(issued).toEqual([]);
    });
  });
}
