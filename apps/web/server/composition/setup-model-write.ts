import { isKeylessProvider } from '@indx-workspace/contracts/models';
import type { SetupPersistenceContext } from './setup-persist';
type ModelConnectionContext = Pick<
  SetupPersistenceContext,
  'workspaceModels' | 'candidate' | 'input' | 'undo'
>;
export async function persistModelConnection(context: ModelConnectionContext) {
  const existingId = context.candidate.existingId;
  return existingId === null
    ? createSetupModelConnection(context)
    : updateSetupModelConnection(context, existingId);
}
async function createSetupModelConnection({
  workspaceModels,
  candidate,
  input,
  undo,
}: ModelConnectionContext) {
  const created = await workspaceModels.create({
    name: candidate.resolved.connection.name,
    provider: input.provider,
    ...(isKeylessProvider(input.provider) ? {} : { apiKey: input.providerApiKey }),
    config: candidate.resolved.connection.config,
  });
  if (created.kind !== 'created')
    return {
      ok: false as const,
      status: 409,
      code: created.kind,
      message: 'The model connection could not be created.',
    };
  const createdId = created.connection.id;

  undo.push({
    label: `delete connection ${createdId}`,
    run: async () => (await workspaceModels.delete(createdId)).kind === 'deleted',
  });
  return { ok: true as const, connectionId: createdId };
}
async function updateSetupModelConnection(
  { workspaceModels, candidate, input, undo }: ModelConnectionContext,
  existingId: string,
) {
  // The row an earlier refused attempt left (deployed 0.2.0, issue #415) is repaired here: it
  // gets the key that just passed the provider test, so it is reused, never joined by a second.

  const stored = candidate.storedConfig;
  const config = candidate.resolved.connection.config;
  if (stored !== null && stored.baseUrl !== config.baseUrl) {
    const updated = await workspaceModels.update(existingId, { config });
    if (updated.kind !== 'updated')
      return {
        ok: false as const,
        status: 409,
        code: updated.kind,
        message: 'The model connection could not be updated.',
      };
    undo.push({
      label: `restore config of connection ${existingId}`,
      run: async () =>
        (await workspaceModels.update(existingId, { config: stored })).kind === 'updated',
    });
  }
  // A keyless row has no secret to reconcile. A row with no secret at all is given a fresh one
  // under the same id; a row with a readable secret has it rotated. An unreadable secret never
  // reaches here (`credential_unreadable`).
  if (!isKeylessProvider(input.provider)) {
    const written = candidate.repairsCredential
      ? await workspaceModels.writeCredential(existingId, input.providerApiKey)
      : await workspaceModels.replaceCredential(existingId, input.providerApiKey);
    if (!written)
      return {
        ok: false as const,
        status: 500,
        code: 'credential_missing',
        message: 'The setup-owned provider credential could not be reconciled.',
      };
  }
  const previous = candidate.previousCredential;
  if (previous !== null) {
    undo.push({
      label: `restore credential of connection ${existingId}`,
      run: () => workspaceModels.writeCredential(existingId, previous),
    });
  }
  return { ok: true as const, connectionId: existingId };
}
