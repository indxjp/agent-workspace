import { createHash } from 'node:crypto';

import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';

import type { RunAgent } from '../agent-versions/session-version';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';

import type { AgentPermissions } from '../../contracts/agents';
import type { AgentRecord } from '../agents/contract';

import type { DiscoverModelsResult, DiscoveredModel } from '../models/discovery';
import type { LaunchContext } from '../runs/environment';

import { InMemoryRunStore } from '../runs/memory-store';

import { type RunTokenIssuer } from '../gateway/issuer';
import { type AgentRunResourceSelection } from './resource-loader';

import { buildRunRequestFor, type RuntimeSettings } from './run-request';
export const EMPTY_SHA256 = createHash('sha256').digest('hex');
export const WORKSPACE = '22222222-2222-4222-8222-222222222222';
export const RUN = '11111111-1111-4111-8111-111111111111';
export const SESSION = '44444444-4444-4444-8444-444444444444';
export const USER = '66666666-6666-4666-8666-666666666666';
export const MODEL_CONNECTION = '77777777-7777-4777-8777-777777777777';
export const SETTINGS: RuntimeSettings = {
  runnerUrl: 'http://runner:8080',
  workspaceRoot: '/workspace',
};
export const SIGNING_SECRET = 's'.repeat(32);
export let issued = 0;
export const GATEWAY: RunTokenIssuer = {
  baseUrl: 'http://gateway:4000',
  issue() {
    issued += 1;
    return Promise.resolve(`run-token-${String(issued)}`);
  },
};
export const ALL_ON: AgentPermissions = {
  readFiles: true,
  writeFiles: true,
  runCommands: true,
  unrestrictedNetwork: true,
};
export const ALL_OFF: AgentPermissions = {
  readFiles: false,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};
export async function rowRunAgent(
  agents: ReturnType<typeof createInMemoryAgentStoreProvider>,
  context: LaunchContext,
): Promise<RunAgent> {
  const agent = await agents.forWorkspace(context.principal.workspaceId).get(context.agent.id);
  if (agent === null) throw new Error(`agent ${context.agent.id} is not in the workspace`);
  return {
    agent,
    assignments: { files: [], skillIds: [], connectorIds: [], storageGrants: [] },
    toolBundles: [],
    subagents: [],
  };
}
export async function launchContext(): Promise<{
  context: LaunchContext;
  agents: ReturnType<typeof createInMemoryAgentStoreProvider>;
  agentId: string;
}> {
  const agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'General',
      instructions: '',
      modelConnectionId: MODEL_CONNECTION,
      model: null,
      permissions: ALL_OFF,
    },
    {
      principalId: '77777777-7777-4777-8777-777777777777',
      userId: '66666666-6666-4666-8666-666666666666',
    },
  );
  if (created.kind !== 'created') throw new Error(created.kind);
  const runs = new InMemoryRunStore();
  const run = await runs.create({
    engine: 'claude-agent-sdk',
    id: RUN,
    workspaceId: WORKSPACE,
    agentId: created.agent.id,
    sessionId: SESSION,
  });
  return {
    agents,
    agentId: created.agent.id,
    context: {
      run,
      agent: { id: created.agent.id, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' },
      session: { id: SESSION, agentId: created.agent.id, engine: null },
      principal: {
        principalId: USER,
        ownerPrincipalId: USER,
        userId: USER,
        workspaceId: WORKSPACE,
        scope: null,
      },
      prompt: 'say pong',
    },
  };
}
export const CAPABILITIES = {
  streaming: true,
  toolUse: true,
  thinking: true,
  promptCaching: false,
  structuredOutput: true,
  contextManagement: true,
  webSearch: true,
  tokenCounting: false,
};
export function fixedDiscovery(
  byConnectionId: Readonly<Record<string, readonly string[]>>,
): (resolved: { connection: { id: string } }) => Promise<DiscoverModelsResult> {
  return (resolved) => {
    const ids = byConnectionId[resolved.connection.id];
    if (ids === undefined) {
      return Promise.resolve({
        ok: false,
        reason: `no fixture models declared for connection ${resolved.connection.id}`,
        failure: { kind: 'unreachable' },
      });
    }
    const models: DiscoveredModel[] = ids.map((id) => ({
      connectionId: resolved.connection.id,
      providerModelId: id,
      displayName: id,
      capabilities: CAPABILITIES,
    }));
    return Promise.resolve({ ok: true, stale: false, models });
  };
}
export const KEY = 'k'.repeat(32);
export const MCP_ID = '00000000-0000-4000-8000-0000000000a1';
export const TOOL_ID = '00000000-0000-4000-8000-0000000000a2';
export const MCP_KEY = 'crm';
export const optedInMcp: AgentRunResourceSelection = {
  files: [],
  skills: [],
  mcpServers: {
    [MCP_KEY]: {
      type: 'http',
      url: 'https://mcp.example.test/mcp',
      headers: { 'X-Api-Key': 'kept', 'X-AW-Identity': 'forged' },
    },
  },
  connectorIdentities: { [MCP_KEY]: { connectorId: MCP_ID, key: KEY } },
};
export const optedInTool: AgentRunResourceSelection = {
  files: [],
  skills: [],
  mcpServers: {},
  toolConnectors: [
    {
      key: 'orders',
      name: 'orders',
      connectorId: TOOL_ID,
      operationNames: ['getOrder'],
      identity: true,
    },
  ],
};
export const member = { via: 'session', kind: 'membership' } as const;
export const apiKey = { via: 'api-key', kind: 'api_key' } as const;
export async function compose(
  resources: AgentRunResourceSelection,
  principal: Partial<LaunchContext['principal']>,
  subject?: string,
  builtin?: 'builder',
  options: { agent?: Partial<AgentRecord>; ceiling?: ProjectPolicy | null } = {},
) {
  const issued: unknown[] = [];
  const gateway: RunTokenIssuer = {
    baseUrl: 'http://gateway:4000',
    issue(claims) {
      issued.push(claims);
      return Promise.resolve('run-token');
    },
  };
  const { context, agents } = await launchContext();
  const row = await rowRunAgent(agents, context);
  const runAgent: RunAgent = {
    ...row,
    agent: { ...row.agent, ...(builtin === undefined ? {} : { builtin }), ...options.agent },
  };
  const run = () =>
    buildRunRequestFor({
      context: {
        ...context,
        principal: { ...context.principal, ...principal },
        ...(subject === undefined ? {} : { subject }),
      },
      runAgent,
      settings: SETTINGS,
      gateway,
      resourceLoader: { load: () => Promise.resolve(resources) },
      snapshotTools: () => Promise.resolve(),
      ceiling: options.ceiling ?? null,
    });
  return { run, issued };
}
