import type { AgentPolicy } from '../../contracts/agents';

import { type AgentRunResourceLoader, type AgentRunResourceSelection } from './resource-loader';
import { buildRunRequestFor, type RunToolSnapshot } from './run-request';
import {
  GATEWAY,
  launchContext,
  rowRunAgent,
  SETTINGS,
  WORKSPACE,
} from './run-request.fixture.test-support';
export function createToolConnectorsFixture() {
  const ORDERS_LOW = '00000000-0000-4000-8000-00000000000a';
  const ORDERS_HIGH = '00000000-0000-4000-8000-00000000000b';
  const WAREHOUSE = '00000000-0000-4000-8000-00000000000c';
  const OTHER_WAREHOUSE = '00000000-0000-4000-8000-00000000000e';
  const MCP_KEY = 'connector-00000000-0000-4000-8000-00000000000d';
  const MCP_ENTRY = {
    type: 'http' as const,
    url: 'https://mcp.example.test/mcp',
    headers: { 'X-Api-Key': 'mcp-connector-secret' },
  };
  function loaderWith(
    toolConnectors: AgentRunResourceSelection['toolConnectors'],
  ): AgentRunResourceLoader {
    return {
      load: () =>
        Promise.resolve({
          files: [],
          skills: [],
          mcpServers: { [MCP_KEY]: MCP_ENTRY },
          ...(toolConnectors === undefined ? {} : { toolConnectors }),
        }),
    };
  }
  async function compose(
    loader: AgentRunResourceLoader,
    snapshotTools: RunToolSnapshot | undefined,
    engine: AgentPolicy | null = null,
  ) {
    const { context, agents, agentId } = await launchContext();
    if (engine !== null) await agents.forWorkspace(WORKSPACE).replacePolicy(agentId, engine);
    return buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
      {},
      undefined,
      null,
      loader,
      undefined,
      null,
      undefined,
      snapshotTools,
    );
  }
  const orders = [
    { key: 'orders', name: 'orders', connectorId: ORDERS_LOW, operationNames: ['getOrder'] },
  ];
  const twoWarehouses = [
    {
      key: 'warehouse',
      name: 'warehouse',
      connectorId: WAREHOUSE,
      operationNames: ['list_tables', 'select'],
    },
    {
      key: 'warehouse_2',
      name: 'warehouse_2',
      connectorId: OTHER_WAREHOUSE,
      operationNames: ['list_tables', 'select'],
    },
  ];
  const openaiAgents: AgentPolicy = {
    engine: 'openai-agents',
    skills: { mode: 'all' },
    limits: { maxTurns: null, maxBudgetUsd: null },
  };
  const mastra: AgentPolicy = {
    engine: 'mastra',
    skills: { mode: 'all' },
    limits: { maxTurns: null, maxBudgetUsd: null },
  };
  return {
    ORDERS_LOW,
    ORDERS_HIGH,
    WAREHOUSE,
    OTHER_WAREHOUSE,
    MCP_KEY,
    MCP_ENTRY,
    loaderWith,
    compose,
    orders,
    twoWarehouses,
    openaiAgents,
    mastra,
  };
}
