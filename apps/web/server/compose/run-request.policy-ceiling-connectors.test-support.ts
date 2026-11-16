import { expect, it } from 'vitest';

import type { createPolicyCeilingFixture } from './run-request.policy-ceiling.fixture.test-support';
export function registerConnectorsCases({
  GITHUB_KEY,
  JIRA_KEY,
  ORDERS_ID,
  WAREHOUSE_ID,
  MCP_ENTRY,
  compose,
}: ReturnType<typeof createPolicyCeilingFixture>) {
  it('drops an MCP connector, a W9 project one included, whose name is outside tools', async () => {
    const request = await compose(
      null,
      { tools: ['github'] },
      {
        loader: {
          load: () =>
            Promise.resolve({
              files: [],
              skills: [],
              mcpServers: { [GITHUB_KEY]: MCP_ENTRY, [JIRA_KEY]: MCP_ENTRY },
              connectorNames: { [GITHUB_KEY]: 'github', [JIRA_KEY]: 'jira' },
            }),
        },
      },
    );
    expect(Object.keys(request.portable.mcpServers)).toEqual([GITHUB_KEY]);
  });
  it('judges a slug-keyed MCP connector by its name under a tools ceiling (#1109)', async () => {
    const request = await compose(
      null,
      { tools: ['github'] },
      {
        loader: {
          load: () =>
            Promise.resolve({
              files: [],
              skills: [],
              mcpServers: { github: MCP_ENTRY, jira: MCP_ENTRY },
              connectorNames: { github: 'github', jira: 'jira' },
            }),
        },
      },
    );
    expect(Object.keys(request.portable.mcpServers)).toEqual(['github']);
  });
  it('drops an MCP entry the loader named no connector for under a tools ceiling (fails closed)', async () => {
    const request = await compose(
      null,
      { tools: ['github'] },
      {
        loader: {
          load: () =>
            Promise.resolve({ files: [], skills: [], mcpServers: { [GITHUB_KEY]: MCP_ENTRY } }),
        },
      },
    );
    expect(request.portable.mcpServers).toEqual({});
  });
  it('snapshots only the tool connectors the ceiling keeps, and composes no entry for the rest', async () => {
    const snapshots: (readonly string[])[] = [];
    const request = await compose(
      null,
      { tools: ['orders'] },
      {
        loader: {
          load: () =>
            Promise.resolve({
              files: [],
              skills: [],
              mcpServers: {},
              toolConnectors: [
                {
                  key: 'orders',
                  name: 'orders',
                  connectorId: ORDERS_ID,
                  operationNames: ['getOrder'],
                },
                {
                  key: 'warehouse',
                  name: 'warehouse',
                  connectorId: WAREHOUSE_ID,
                  operationNames: ['select'],
                },
              ],
            }),
        },
        snapshot: (_runId, ids) => {
          snapshots.push(ids);
          return Promise.resolve();
        },
      },
    );
    expect(snapshots).toEqual([[ORDERS_ID]]);
    expect(Object.keys(request.portable.mcpServers)).toEqual(['orders']);
  });
}
