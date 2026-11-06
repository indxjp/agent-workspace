import { log } from '../telemetry/logger';
import type { RepositoryConnectorsStoreDependencies, WorkspaceConnectorsStore } from './store';
import { fieldsOf, toUpdateOutcome } from './store-mapping';

type ConnectorRepository = ReturnType<
  RepositoryConnectorsStoreDependencies['mcpServers']['forScope']
>;
type CoreWorkspaceScope = NonNullable<
  Awaited<ReturnType<RepositoryConnectorsStoreDependencies['scopes']['forWorkspaceId']>>
>;
type CoreUpdateMcpServerOutcome = Awaited<ReturnType<ConnectorRepository['update']>>;
type CoreSecretsService = RepositoryConnectorsStoreDependencies['secrets'];

interface ConnectorWriteContext {
  readonly dependencies: RepositoryConnectorsStoreDependencies;
  readonly scope: () => Promise<CoreWorkspaceScope>;
}

/** Every secret name this task's connectors mint follows this prefix, so a support transcript (or
 *  a future audit) can tell a connector's own credential apart from any other secret at a glance. */
const CREDENTIAL_SECRET_PREFIX = 'MCP_CONNECTOR_CREDENTIAL_';

/** A fresh, always-unique, schema-valid secret name (`secrets_name_shape`:
 *  `^[A-Z][A-Z0-9_]{0,127}$`) — a random suffix rather than one derived from the connector's own
 *  name, so renaming or recreating a connector can never collide with an orphaned secret left by
 *  an earlier attempt (see this file's header on the declared orphan-secret gap). */
function freshCredentialSecretName(): string {
  const suffix = crypto.randomUUID().replace(/-/g, '').toUpperCase();
  return `${CREDENTIAL_SECRET_PREFIX}${suffix}`;
}

/**
 * Deletes the secret a credential replacement just unreferenced (ADR-0077 D5). The connector row
 * already names the fresh secret, so a failure here must not roll the connector back: it leaves an
 * unreferenced secret, never a credential on the wrong destination. It is logged by id (never by
 * value) so an Owner can delete the orphan with `DELETE /api/secrets/:id`.
 */
async function retireReplacedCredential(
  secrets: CoreSecretsService,
  scope: CoreWorkspaceScope,
  connectorId: string,
  secretId: string,
): Promise<void> {
  let failure: string;
  try {
    const cleanup = await secrets.delete(scope, secretId);
    if (cleanup.kind !== 'in-use') return;
    failure = 'it is still referenced';
  } catch (error) {
    failure = error instanceof Error ? error.name : 'unknown error';
  }
  log.error(
    `[connectors] connector ${connectorId} now uses a fresh credential secret, but deleting the ` +
      `replaced secret ${secretId} failed; it is orphaned until an Owner deletes it`,
    { failure },
  );
}

/**
 * Seal a raw credential as a fresh secret and answer its id. The row that will name it does not
 * exist yet, so the caller deletes it again if that row is not written.
 */
async function sealCredential(
  secrets: CoreSecretsService,
  scope: CoreWorkspaceScope,
  value: string,
): Promise<string> {
  const sealed = await secrets.create(scope, {
    name: freshCredentialSecretName(),
    value: Buffer.from(value, 'utf8'),
  });
  if (sealed.kind !== 'created') {
    throw new Error(
      `unreachable: a freshly generated secret name collided (${sealed.kind}) — ` +
        'freshCredentialSecretName() is a random 32-hex-character suffix',
    );
  }
  return sealed.secret.id;
}

/** Delete a secret this request sealed but no row came to name. */
async function discardSealed(
  secrets: CoreSecretsService,
  scope: CoreWorkspaceScope,
  secretId: string,
): Promise<void> {
  const cleanup = await secrets.delete(scope, secretId);
  if (cleanup.kind === 'in-use') {
    throw new Error('a connector write failed, and credential compensation is in-use');
  }
}
export async function createConnector(
  context: ConnectorWriteContext,
  input: Parameters<WorkspaceConnectorsStore['create']>[0],
  owner: Parameters<WorkspaceConnectorsStore['create']>[1],
): ReturnType<WorkspaceConnectorsStore['create']> {
  const { dependencies, scope } = context;

  const resolved = await scope();

  // Sealed BEFORE the row is inserted, because the row's `credentialSecretId` needs an id
  // that already exists — `mcp_servers_credential_secret_workspace_fk` requires it. If the
  // insert below fails (most likely: a name conflict), the secret is deleted again.
  let credentialSecretId: string | null =
    input.authType !== 'none' && input.credential !== null
      ? await sealCredential(dependencies.secrets, resolved, input.credential)
      : null;

  try {
    const outcome = await dependencies.mcpServers.forScope(resolved).create({
      name: input.name,
      transport: input.transport,
      command: input.command,
      args: input.args === null ? null : [...input.args],
      url: input.url,
      authType: input.authType,
      credentialSecretId,
      identitySecretName: input.identity?.secret ?? null,
      enabled: true,
      ownerPrincipalId: owner.principalId,
      createdBy: owner.userId,
    });
    if (outcome.kind !== 'created' && credentialSecretId !== null) {
      const cleanup = await dependencies.secrets.delete(resolved, credentialSecretId);
      // Compensation has now been attempted exactly once. Clearing the id here (whether
      // or not the delete itself reported "deleted") stops the surrounding `catch` below
      // from re-running the same delete a second time when the `throw` below sends control
      // there — a second call on an already-handled id could obscure this failure's real
      // `cleanup.kind` behind a second, unrelated one.
      const failedCleanupKind = cleanup.kind !== 'deleted' ? cleanup.kind : null;
      credentialSecretId = null;
      if (failedCleanupKind !== null) {
        throw new Error(
          `connector create failed with ${outcome.kind}, and credential compensation failed with ${failedCleanupKind}`,
        );
      }
    }
    return outcome;
  } catch (error) {
    if (credentialSecretId !== null) {
      const cleanup = await dependencies.secrets.delete(resolved, credentialSecretId);
      if (cleanup.kind !== 'deleted' && cleanup.kind !== 'not-found') {
        throw new AggregateError(
          [error, new Error(`credential compensation failed with ${cleanup.kind}`)],
          'connector creation and credential compensation both failed',
          { cause: error },
        );
      }
    }
    throw error;
  }
}

export async function updateConnector(
  context: ConnectorWriteContext,
  id: Parameters<WorkspaceConnectorsStore['update']>[0],
  patch: Parameters<WorkspaceConnectorsStore['update']>[1],
): ReturnType<WorkspaceConnectorsStore['update']> {
  const { dependencies, scope } = context;

  const resolved = await scope();
  const repository = dependencies.mcpServers.forScope(resolved);
  const existing = await repository.get(id);
  if (existing === null) return { kind: 'not-found' };
  const nextAuthType = patch.authType ?? existing.authType;
  const fields = fieldsOf(patch);

  // Dropping the credential: the row stops referencing the secret first, so the secret is
  // unreferenced by the time it is deleted.
  if (nextAuthType === 'none' && existing.credentialSecretId !== null) {
    const updated = await repository.update(id, { ...fields, credentialSecretId: null });
    if (updated.kind === 'updated') {
      const cleanup = await dependencies.secrets.delete(resolved, existing.credentialSecretId);
      if (cleanup.kind === 'in-use') {
        throw new Error(`updated connector ${id}, but its old credential is still in use`);
      }
    }
    return toUpdateOutcome(updated);
  }

  if (
    nextAuthType !== 'none' &&
    existing.credentialSecretId === null &&
    patch.credential === undefined
  ) {
    throw new Error('unreachable: the handler requires a credential for this change');
  }

  // A new credential — gained or replaced — is sealed as a FRESH secret before the row names
  // it (the foreign key requires the secret to exist), and the destination fields and the
  // secret reference land in ONE row update (ADR-0077 D5): no failure can leave the
  // connector pointing at a new destination with its old credential. The fresh secret is
  // deleted again if the row update does not land; the old secret is retired only after.
  if (patch.credential !== undefined)
    return replaceConnectorCredential(
      { dependencies, resolved, repository, existing },
      id,
      fields,
      patch.credential,
    );

  // No credential in the patch: the saved secret stays, and only the fields change.
  const updated = await repository.update(id, fields);
  return toUpdateOutcome(updated);
}

export { retireReplacedCredential, sealCredential, discardSealed };

async function replaceConnectorCredential(
  context: {
    readonly dependencies: RepositoryConnectorsStoreDependencies;
    readonly resolved: CoreWorkspaceScope;
    readonly repository: ConnectorRepository;
    readonly existing: NonNullable<Awaited<ReturnType<ConnectorRepository['get']>>>;
  },
  id: string,
  fields: Parameters<ConnectorRepository['update']>[1],
  credential: string,
): ReturnType<WorkspaceConnectorsStore['update']> {
  const { dependencies, resolved, repository, existing } = context;

  const sealedId = await sealCredential(dependencies.secrets, resolved, credential);
  let updated: CoreUpdateMcpServerOutcome;
  try {
    updated = await repository.update(id, {
      ...fields,
      credentialSecretId: sealedId,
    });
  } catch (error) {
    const cleanup = await dependencies.secrets.delete(resolved, sealedId);
    if (cleanup.kind === 'in-use') {
      throw new AggregateError(
        [error, new Error('credential compensation failed with in-use')],
        'connector update and credential compensation both failed',
        { cause: error },
      );
    }
    throw error;
  }
  if (updated.kind !== 'updated') {
    const cleanup = await dependencies.secrets.delete(resolved, sealedId);
    if (cleanup.kind === 'in-use') {
      throw new Error('connector update failed, and credential compensation is in-use');
    }
  } else if (existing.credentialSecretId !== null) {
    await retireReplacedCredential(dependencies.secrets, resolved, id, existing.credentialSecretId);
  }
  return toUpdateOutcome(updated);
}
