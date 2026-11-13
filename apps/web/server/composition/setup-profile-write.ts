import type { SetupPersistenceContext } from './setup-persist';
type ProfileContext = Pick<
  SetupPersistenceContext,
  'root' | 'scope' | 'input' | 'undo' | 'runtimeNetworkPolicy'
>;
type SetupProfiles = ReturnType<SetupPersistenceContext['root']['runtimeProfiles']['forScope']>;
function setupProfileDefinition(
  context: Pick<ProfileContext, 'input' | 'runtimeNetworkPolicy'>,
  runtimeConnectionId: string | null,
) {
  const { input } = context;
  const profileName = `${input.runtime} default`;
  return {
    name: profileName,
    driver: input.runtime as Parameters<SetupProfiles['create']>[0]['driver'],
    runtimeConnectionId,
    cpu: null,
    memoryMb: null,
    diskMb: null,
    networkPolicy: context.runtimeNetworkPolicy,
    allowedDomains: null,
    filesystem: 'read-write' as const,
    persistPaths: null,
    timeoutSeconds: null,
    idleTimeoutSeconds: null,
    driverConfig: null,
  };
}
type ProfileWriteContext = {
  readonly profiles: SetupProfiles;
  readonly profileDefinition: ReturnType<typeof setupProfileDefinition>;
  readonly undo: SetupPersistenceContext['undo'];
};
export async function persistRuntimeProfile(
  context: ProfileContext,
  runtimeConnectionId: string | null,
) {
  const profiles = context.root.runtimeProfiles.forScope(context.scope);
  const profileDefinition = setupProfileDefinition(context, runtimeConnectionId);
  const existingProfile = (await profiles.list()).find(
    (entry) => entry.name === profileDefinition.name,
  );
  const write = { profiles, profileDefinition, undo: context.undo };
  const written =
    existingProfile === undefined
      ? await createSetupProfile(write)
      : await updateSetupProfile(write, existingProfile);
  if (!written.ok) return written;
  return { ok: true as const, profileId: written.profileId, profiles, profileDefinition };
}
async function createSetupProfile({ profiles, profileDefinition, undo }: ProfileWriteContext) {
  const created = await profiles.create(profileDefinition);
  if (created.kind !== 'created')
    return {
      ok: false as const,
      status: 409,
      code: created.kind,
      message: 'The runtime profile could not be created.',
    };
  const createdId = created.profile.id;

  undo.push({
    label: `delete runtime profile ${createdId}`,
    run: async () => (await profiles.delete(createdId)).kind === 'deleted',
  });
  return { ok: true as const, profileId: createdId };
}
async function updateSetupProfile(
  { profiles, profileDefinition, undo }: ProfileWriteContext,
  existingProfile: Awaited<ReturnType<SetupProfiles['list']>>[number],
) {
  const existingId = existingProfile.id;

  const updated = await profiles.update(existingId, profileDefinition);
  if (updated.kind !== 'updated')
    return {
      ok: false as const,
      status: 409,
      code: updated.kind,
      message: 'The existing setup runtime profile could not be reconciled.',
    };
  // Put back every field this update overwrote.
  const previous = {
    name: existingProfile.name,
    driver: existingProfile.driver,
    runtimeConnectionId: existingProfile.runtimeConnectionId,
    cpu: existingProfile.cpu,
    memoryMb: existingProfile.memoryMb,
    diskMb: existingProfile.diskMb,
    networkPolicy: existingProfile.networkPolicy,
    allowedDomains: existingProfile.allowedDomains,
    filesystem: existingProfile.filesystem,
    persistPaths: existingProfile.persistPaths,
    timeoutSeconds: existingProfile.timeoutSeconds,
    idleTimeoutSeconds: existingProfile.idleTimeoutSeconds,
    driverConfig: existingProfile.driverConfig,
  };
  undo.push({
    label: `restore runtime profile ${existingId}`,
    run: async () => (await profiles.update(existingId, previous)).kind === 'updated',
  });
  return { ok: true as const, profileId: existingId };
}
