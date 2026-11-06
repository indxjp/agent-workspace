import type {
  AnyConnectorResource,
  ToolConnectorResource,
  ConnectorResource,
} from '../connectors/contract';
import type { WorkspaceConnectorsStore, WorkspaceConnectorsProbeSource } from '../connectors/store';
import type { McpServerConfig } from '@agent-workspace/run-protocol';
import { CONNECTOR_DISABLED_RUN_ERROR_CODE } from '@indx-workspace/contracts/connectors';
import {
  POSTGRES_TOOL_OPERATION_NAMES,
  connectorServerKey,
  toolApprovalRules,
  toolServerKeys,
  type ToolOperationMethod,
} from '@indx-workspace/contracts/tool-connectors';
import { CONNECTOR_IDENTITY_UNSUPPORTED } from '../connectors/identity';
import { DomainError } from '../errors';
import {
  type AgentRunResourceSelection,
  type AgentRunResourceLoaderDependencies,
  type ConnectorIdentityKey,
} from './resource-loader-contract';

type LoadedConnectors = Pick<
  AgentRunResourceSelection,
  'mcpServers' | 'connectorNames' | 'connectorKeys' | 'connectorIdentities' | 'toolConnectors'
>;

type LoadedMcpConnector = {
  readonly id: string;
  readonly name: string;
  readonly config: McpServerConfig;
  readonly identityKey?: string;
};
type LoadedToolConnector = {
  connectorId: string;
  name: string;
  operationNames: readonly string[];
  operations: readonly { readonly name: string; readonly method: ToolOperationMethod }[];
  identity?: true;
};
async function loadConnectorIdentity(
  connector: AnyConnectorResource,
  store: WorkspaceConnectorsStore & WorkspaceConnectorsProbeSource,
): Promise<string | undefined> {
  // ADR-0142 D1: an opted-in connector whose secret cannot be read fails the run here, so it is
  // never dialled without the identity it asked for.
  const identityKey =
    connector.identity === undefined ? undefined : await store.resolveIdentityKey(connector.id);

  if (identityKey === null) {
    throw new DomainError({
      category: 'validation',
      code: CONNECTOR_IDENTITY_UNSUPPORTED,
      publicMessage:
        `${CONNECTOR_IDENTITY_UNSUPPORTED}: connector ${connector.id} names an identity secret ` +
        'this workspace cannot resolve; create the secret, or remove "identity" from the connector',
    });
  }
  return identityKey;
}
function loadedToolConnector(
  connector: ToolConnectorResource,
  projectConnectorIds: ReadonlySet<string>,
  identityKey: string | undefined,
): LoadedToolConnector {
  // #586: a project binds MCP connectors only, and its write path refuses a tool connector; a
  // binding written before that refusal is refused here rather than handed to the engine.
  if (projectConnectorIds.has(connector.id)) {
    throw new DomainError({
      category: 'validation',
      code: 'project_connector_not_mcp',
      publicMessage:
        `project_connector_not_mcp: connector ${connector.id} is a ${connector.kind} tool ` +
        'connector; remove it from the project and assign it to the agent instead',
    });
  }
  const needsCredential =
    connector.kind === 'postgres' || (connector.openapi?.auth ?? 'none') !== 'none';
  if (needsCredential && !connector.hasCredential) {
    throw new Error(
      `assigned connector ${JSON.stringify(connector.name)} has no resolvable credential`,
    );
  }
  const operations = connector.kind === 'postgres' ? [] : (connector.openapi?.operations ?? []);
  return {
    connectorId: connector.id,
    name: connector.name,
    operationNames:
      connector.kind === 'postgres'
        ? [...POSTGRES_TOOL_OPERATION_NAMES]
        : operations.map((operation) => operation.name),
    operations,
    ...(identityKey === undefined ? {} : { identity: true as const }),
  };
}
function loadedMcpConnector(
  connector: ConnectorResource,
  probe: Awaited<ReturnType<WorkspaceConnectorsProbeSource['resolveForProbe']>>,
  identityKey: string | undefined,
): LoadedMcpConnector {
  if (probe === null) {
    throw new Error(`assigned connector ${JSON.stringify(connector.name)} could not be resolved`);
  }

  if (connector.authType !== 'none' && !probe.credentialConfigured) {
    throw new Error(
      `assigned connector ${JSON.stringify(connector.name)} has no resolvable credential`,
    );
  }

  return {
    id: connector.id,
    name: connector.name,
    ...(identityKey === undefined ? {} : { identityKey }),
    config:
      probe.transport === 'stdio'
        ? {
            type: 'stdio',
            command: probe.command,
            args: [...probe.args],
            ...(Object.keys(probe.env).length === 0 ? {} : { env: { ...probe.env } }),
          }
        : {
            type: probe.transport,
            url: probe.url,
            ...(Object.keys(probe.headers).length === 0 ? {} : { headers: { ...probe.headers } }),
          },
  };
}
function assembleConnectors(
  mcps: LoadedMcpConnector[],
  tools: LoadedToolConnector[],
): LoadedConnectors {
  // SD13 orders a run's colliding names by connector id.
  tools.sort((a, b) => (a.connectorId < b.connectorId ? -1 : 1));

  const keys = toolServerKeys(tools.map((tool) => tool.name));

  // Tool keys are fixed first; an MCP connector whose name spells one falls back to its id (#1109).
  const taken = new Set(keys);

  const configs: Record<string, McpServerConfig> = {};

  const names: Record<string, string> = {};

  const connectorKeys: Record<string, string> = {};

  const identities: Record<string, ConnectorIdentityKey> = {};

  for (const mcp of mcps) {
    const key = connectorServerKey(mcp.name, mcp.id, taken);
    configs[key] = mcp.config;
    names[key] = mcp.name;
    connectorKeys[mcp.id] = key;
    if (mcp.identityKey !== undefined) {
      identities[key] = { connectorId: mcp.id, key: mcp.identityKey };
    }
  }

  const connectorIdentities =
    Object.keys(identities).length === 0 ? {} : { connectorIdentities: identities };

  if (tools.length === 0) {
    return { mcpServers: configs, connectorNames: names, connectorKeys, ...connectorIdentities };
  }

  return {
    mcpServers: configs,
    connectorNames: names,
    connectorKeys,
    ...connectorIdentities,
    toolConnectors: tools.map((tool, index) => {
      const key = keys[index];
      if (key === undefined) throw new Error('toolServerKeys returned fewer keys than names');
      const approvalRules = toolApprovalRules(key, tool.operations);
      return {
        key,
        connectorId: tool.connectorId,
        name: tool.name,
        operationNames: tool.operationNames,
        ...(approvalRules.length === 0 ? {} : { approvalRules }),
        ...(tool.identity === undefined ? {} : { identity: true as const }),
      };
    }),
  };
}

async function loadConnectors(
  workspaceId: string,
  connectorIds: readonly string[],
  projectConnectorIds: ReadonlySet<string>,
  dependencies: AgentRunResourceLoaderDependencies,
): Promise<LoadedConnectors> {
  if (connectorIds.length === 0) return { mcpServers: {} };

  if (dependencies.connectors === undefined) {
    throw new Error('this agent has assigned connectors, but connector storage is not configured');
  }

  const store = dependencies.connectors.forWorkspace(workspaceId);
  const mcps: LoadedMcpConnector[] = [];
  const tools: LoadedToolConnector[] = [];
  for (const connectorId of connectorIds) {
    const [connector, probe] = await Promise.all([
      store.get(connectorId),
      store.resolveForProbe(connectorId),
    ]);

    if (connector === null) {
      throw new Error(`assigned connector ${connectorId} disappeared before the run was composed`);
    }

    // A disabled connector is refused, not dropped: a run that silently lost a tool its agent was
    // configured with would fail later and further from the cause (#240). The same holds for one a
    // project association brings in (issue #125), so the message names both sources.
    if (!connector.enabled) {
      throw new DomainError({
        category: 'conflict',
        code: CONNECTOR_DISABLED_RUN_ERROR_CODE,
        publicMessage:
          `${CONNECTOR_DISABLED_RUN_ERROR_CODE}: connector ${connector.id} is disabled; ` +
          'enable it, or remove it from the agent or the project that brings it into this run',
      });
    }
    const identityKey = await loadConnectorIdentity(connector, store);
    if (isToolConnector(connector)) {
      tools.push(loadedToolConnector(connector, projectConnectorIds, identityKey));
      continue;
    }
    mcps.push(loadedMcpConnector(connector, probe, identityKey));
  }
  return assembleConnectors(mcps, tools);
}
export { loadConnectors };

function isToolConnector(connector: AnyConnectorResource): connector is ToolConnectorResource {
  return connector.kind === 'openapi' || connector.kind === 'postgres';
}
