import { toToolUpdateOutcome } from './store-mapping';
import { sealCredential, discardSealed, retireReplacedCredential } from './store-credential-writes';
import { toToolConnectorResource } from './contract';
import type { ToolConnectorWrite } from './tools';
import type {
  WorkspaceConnectorContext,
  WorkspaceConnectorsStore,
  ToolConnectorChange,
} from './store';
export async function createToolConnector(
  context: WorkspaceConnectorContext,
  write: ToolConnectorWrite,
  owner: Parameters<WorkspaceConnectorsStore['createToolConnector']>[1],
): ReturnType<WorkspaceConnectorsStore['createToolConnector']> {
  const { dependencies, scope } = context;
  const resolved = await scope();
  const tools = dependencies.mcpServers.forScope(resolved);
  const secretId =
    write.credential === null
      ? null
      : await sealCredential(dependencies.secrets, resolved, write.credential);
  let outcome: Awaited<ReturnType<typeof tools.createToolConnector>>;
  try {
    outcome = await tools.createToolConnector({
      name: write.name,
      kind: write.kind,
      toolConfig: { ...write.toolConfig },
      openapiDocument: write.openapiDocument,
      credentialSecretId: secretId,
      identitySecretName: write.identity?.secret ?? null,
      enabled: true,
      ownerPrincipalId: owner.principalId,
      createdBy: owner.userId,
    });
  } catch (error) {
    if (secretId !== null) await discardSealed(dependencies.secrets, resolved, secretId);
    throw error;
  }
  if (outcome.kind === 'created') {
    return { kind: 'created', connector: toToolConnectorResource(outcome.connector) };
  }
  if (secretId !== null) await discardSealed(dependencies.secrets, resolved, secretId);
  if (outcome.kind === 'name-conflict') return outcome;
  throw new Error('a tool connector named a credential secret that does not exist');
}
export async function replaceToolConnector(
  context: WorkspaceConnectorContext,
  id: string,
  change: ToolConnectorChange,
): ReturnType<WorkspaceConnectorsStore['replaceToolConnector']> {
  const { dependencies, scope } = context;
  const resolved = await scope();
  const tools = dependencies.mcpServers.forScope(resolved);
  const existing = await tools.getToolConnector(id);
  if (existing === null) return { kind: 'not-found' };
  if (change.kind === undefined) {
    return toToolUpdateOutcome(
      await tools.updateToolConnector(id, {
        ...(change.name === undefined ? {} : { name: change.name }),
        ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
      }),
    );
  }
  // A full replacement: a credential sent with it is sealed fresh and lands in the same row
  // update as the new document or host (ADR-0077 D5); the replaced secret is retired after.
  const secretId =
    change.credential === null
      ? null
      : await sealCredential(dependencies.secrets, resolved, change.credential);
  let updated: Awaited<ReturnType<typeof tools.updateToolConnector>>;
  try {
    updated = await tools.updateToolConnector(id, {
      name: change.name,
      toolConfig: { ...change.toolConfig },
      openapiDocument: change.openapiDocument,
      credentialSecretId: secretId,
      identitySecretName: change.identity?.secret ?? null,
    });
  } catch (error) {
    if (secretId !== null) await discardSealed(dependencies.secrets, resolved, secretId);
    throw error;
  }
  if (updated.kind !== 'updated') {
    if (secretId !== null) await discardSealed(dependencies.secrets, resolved, secretId);
  } else if (existing.credentialSecretId !== null) {
    await retireReplacedCredential(dependencies.secrets, resolved, id, existing.credentialSecretId);
  }
  return toToolUpdateOutcome(updated);
}
