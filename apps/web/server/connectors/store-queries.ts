import { byCreatedThenId } from './store-mapping';
import { toResource, buildTestConfig } from './store-mapping';
import { isPlatformOwnedSecretName } from '../secrets';
import { toToolConnectorResource } from './contract';
import type {
  WorkspaceConnectorContext,
  WorkspaceConnectorsStore,
  WorkspaceConnectorsProbeSource,
} from './store';
export async function listConnectors(
  context: WorkspaceConnectorContext,
): ReturnType<WorkspaceConnectorsStore['list']> {
  const { dependencies, scope } = context;
  const resolved = await scope();
  const repository = dependencies.mcpServers.forScope(resolved);
  const [mcp, tools] = await Promise.all([repository.list(), repository.listToolConnectors()]);
  return [...mcp.map(toResource), ...tools.map(toToolConnectorResource)].sort(byCreatedThenId);
}
export async function getConnector(
  context: WorkspaceConnectorContext,
  id: string,
): ReturnType<WorkspaceConnectorsStore['get']> {
  const { dependencies, scope } = context;
  const resolved = await scope();
  const repository = dependencies.mcpServers.forScope(resolved);
  const row = await repository.get(id);
  if (row !== null) return toResource(row);
  const tool = await repository.getToolConnector(id);
  return tool === null ? null : toToolConnectorResource(tool);
}
export async function readConnectorDocument(
  context: WorkspaceConnectorContext,
  id: string,
): ReturnType<WorkspaceConnectorsStore['openapiDocument']> {
  const { dependencies, scope } = context;
  const resolved = await scope();
  return dependencies.mcpServers.forScope(resolved).getOpenApiDocument(id);
}
export async function readConnectorIdentityKey(
  context: WorkspaceConnectorContext,
  id: string,
): ReturnType<WorkspaceConnectorsProbeSource['resolveIdentityKey']> {
  const { dependencies, scope } = context;
  const resolved = await scope();
  const repository = dependencies.mcpServers.forScope(resolved);
  const record = (await repository.get(id)) ?? (await repository.getToolConnector(id));
  if (record === null || record.identitySecretName === null) return undefined;
  // Never a platform-owned credential, even on a row stored before it was refused.
  if (isPlatformOwnedSecretName(record.identitySecretName)) return null;
  const secret = await dependencies.secrets.resolveByName(resolved, record.identitySecretName);
  return secret === null ? null : secret.value.toString('utf8');
}
export async function resolveConnectorProbe(
  context: WorkspaceConnectorContext,
  id: string,
): ReturnType<WorkspaceConnectorsProbeSource['resolveForProbe']> {
  const { dependencies, scope } = context;
  const resolved = await scope();
  const record = await dependencies.mcpServers.forScope(resolved).get(id);
  if (record === null) return null;
  if (record.credentialSecretId === null) return buildTestConfig(record, null);

  // The credential is resolved directly by its stored id — server-side only, the W2-CP-05
  // caller this wave's plan names. A missing or foreign id answers `null`.
  const resolvedSecret = await dependencies.secrets.resolveById(
    resolved,
    record.credentialSecretId,
  );
  if (resolvedSecret === null) return buildTestConfig(record, null);
  return buildTestConfig(record, resolvedSecret.value.toString('utf8'));
}
