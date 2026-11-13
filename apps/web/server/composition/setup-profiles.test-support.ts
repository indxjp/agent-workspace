import { expect, it } from 'vitest';
import {
  complete,
  CONNECTION_NAME,
  db,
  expectUntouched,
  scope,
  SEEDED_MODEL,
  setupInput,
  snapshot,
  withFailingRoot,
} from './setup-fixture.test-support';
import { GOOD_KEY_2 } from './setup-provider.test-support';

export function registerRuntimeProfilesTests(): void {
  it('rotates the key on a re-run: the same connection, now with the new key', async () => {
    const first = await complete(setupInput());
    if (!first.ok) throw new Error(`setup refused: ${first.code}`);
    const second = await complete(setupInput({ providerApiKey: GOOD_KEY_2 }));
    if (!second.ok) throw new Error(`the re-run was refused: ${second.code}`);
    expect(second.modelConnectionId).toBe(first.modelConnectionId);
    const state = await snapshot();
    expect(state.connections).toEqual([
      { id: first.modelConnectionId, name: CONNECTION_NAME, ready: true, credential: GOOD_KEY_2 },
    ]);
    expect(state.workspaceDefault).toEqual({
      connectionId: first.modelConnectionId,
      model: SEEDED_MODEL,
    });
  });

  it('makes its runtime profile the workspace default, so a version naming no profile resolves to it', async () => {
    const references = {
      modelConnectionName: null,
      runtimeProfileName: null,
      skills: [],
      connectors: [],
      files: [],
    } as const;
    const versions = db().agentVersions.forScope(scope());
    // Before setup nothing is the default: an agent pushed now would have no runtime profile.
    await expect(versions.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'resolved',
      references: { runtimeProfileId: null },
    });

    const first = await complete(setupInput());
    if (!first.ok) throw new Error(`setup refused: ${first.code}`);
    await expect(
      db().runtimeProfiles.forScope(scope()).findWorkspaceDefault(),
    ).resolves.toMatchObject({ id: first.runtimeProfileId });
    await expect(versions.resolveDefinition(references)).resolves.toMatchObject({
      kind: 'resolved',
      references: { runtimeProfileId: first.runtimeProfileId },
    });

    // A re-run keeps the one default.
    const again = await complete(setupInput());
    if (!again.ok) throw new Error(`the re-run was refused: ${again.code}`);
    await expect(
      db().runtimeProfiles.forScope(scope()).findWorkspaceDefault(),
    ).resolves.toMatchObject({ id: first.runtimeProfileId });
  });

  it('keeps a workspace default someone already chose', async () => {
    const profiles = db().runtimeProfiles.forScope(scope());
    const chosen = await profiles.ensureWorkspaceDefault(
      {
        name: 'chosen',
        driver: 'docker',
        runtimeConnectionId: null,
        cpu: null,
        memoryMb: null,
        diskMb: null,
        networkPolicy: 'none',
        allowedDomains: null,
        filesystem: 'read-only',
        persistPaths: null,
        timeoutSeconds: null,
        idleTimeoutSeconds: null,
        driverConfig: null,
      },
      { adoptable: () => true },
    );
    if (chosen.kind !== 'created') throw new Error(`expected created, got ${chosen.kind}`);
    const result = await complete(setupInput());
    if (!result.ok) throw new Error(`setup refused: ${result.code}`);
    expect(result.runtimeProfileId).not.toBe(chosen.profile.id);
    await expect(profiles.findWorkspaceDefault()).resolves.toMatchObject({ id: chosen.profile.id });
  });

  it.each(['name-conflict', 'not-adoptable'] as const)(
    'rolls every write back when the runtime profile cannot be made the default (%s)',
    async (kind) => {
      // The last write: the connection, profile, agent and setup mark have landed when it refuses.
      const live = db();
      await withFailingRoot(
        {
          runtimeProfiles: {
            forScope: (target) => {
              const repository = live.runtimeProfiles.forScope(target);
              return Object.assign(Object.create(repository) as typeof repository, {
                ensureWorkspaceDefault: async () => {
                  if (kind === 'name-conflict') return { kind, name: 'local default' };
                  const [profile] = await repository.list();
                  if (profile === undefined) throw new Error('setup wrote no runtime profile');
                  return { kind, profile };
                },
              });
            },
          },
        },
        async () => {
          expect(await complete(setupInput())).toMatchObject({
            ok: false,
            status: 409,
            code: kind,
          });
        },
      );
      await expectUntouched();
      await expect(
        db().runtimeProfiles.forScope(scope()).findWorkspaceDefault(),
      ).resolves.toBeNull();
    },
  );
}
