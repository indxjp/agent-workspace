import { toResource } from './store-mapping';
import type { WorkspaceConnectorContext, WorkspaceConnectorsStore } from './store';
export async function deleteConnector(
  context: WorkspaceConnectorContext,
  id: string,
): ReturnType<WorkspaceConnectorsStore['delete']> {
  const { dependencies, scope } = context;
  const resolved = await scope();
  const repository = dependencies.mcpServers.forScope(resolved);
  const existing: { readonly credentialSecretId: string | null } | null =
    (await repository.get(id)) ?? (await repository.getToolConnector(id));
  if (existing === null) return { kind: 'not-found' };
  const outcome = await repository.delete(id);
  if (outcome.kind === 'deleted' && existing.credentialSecretId !== null) {
    const cleanup = await dependencies.secrets.delete(resolved, existing.credentialSecretId);
    if (cleanup.kind !== 'deleted' && cleanup.kind !== 'not-found') {
      throw new Error(`deleted connector ${id}, but its credential is still ${cleanup.kind}`);
    }
  }
  return outcome;
}
export async function rotateConnectorCredential(
  context: WorkspaceConnectorContext,
  id: string,
  credential: string,
): ReturnType<WorkspaceConnectorsStore['rotateCredential']> {
  const { dependencies, scope } = context;
  const resolved = await scope();
  const repository = dependencies.mcpServers.forScope(resolved);
  const existing = await repository.get(id);
  if (existing === null) return { kind: 'not-found' };
  if (existing.credentialSecretId === null || existing.authType === 'none') {
    return { kind: 'credential-not-configured' };
  }
  const replaced = await dependencies.secrets.replace(
    resolved,
    existing.credentialSecretId,
    Buffer.from(credential, 'utf8'),
  );
  if (replaced.kind === 'not-found') return { kind: 'credential-not-configured' };
  const updated = await repository.get(id);
  if (updated === null) return { kind: 'not-found' };
  return { kind: 'rotated', connector: toResource(updated) };
}
