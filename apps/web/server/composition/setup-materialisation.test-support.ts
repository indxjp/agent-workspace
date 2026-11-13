import { expect, it } from 'vitest';
import {
  complete,
  CONNECTION_NAME,
  db,
  scope,
  secrets,
  setupInput,
  snapshot,
} from './setup-fixture.test-support';
import { GOOD_KEY_2 } from './setup-provider.test-support';
import { pushedAgentAfterSetup } from './setup-push.test-support';

export function registerMaterialisationTests(): void {
  it('keeps the current runtime profile when a version naming none is applied after a console edit', async () => {
    const { setup, agentId, push } = await pushedAgentAfterSetup();

    // The console moves the agent to another profile (`PATCH /api/agents/:id`).
    const other = await db().runtimeProfiles.forScope(scope()).create({
      name: 'console choice',
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
    });
    if (other.kind !== 'created') throw new Error(`expected created, got ${other.kind}`);
    const patched = await db()
      .agents.forScope(scope())
      .update(agentId, { runtimeProfileId: other.profile.id });
    if (patched.kind !== 'updated') throw new Error(`expected updated, got ${patched.kind}`);

    // The next push names no profile either: the console's choice stays, not the setup default.
    await expect(push()).resolves.toMatchObject({ runtimeProfileId: other.profile.id });
    await expect(db().agents.forScope(scope()).get(agentId)).resolves.toMatchObject({
      runtimeProfileId: other.profile.id,
    });
    await expect(
      db().runtimeProfiles.forScope(scope()).findWorkspaceDefault(),
    ).resolves.toMatchObject({ id: setup.runtimeProfileId });
  });

  it('gives an agent with no runtime profile the workspace default when a version naming none is applied', async () => {
    const { setup, agentId, push } = await pushedAgentAfterSetup();
    const cleared = await db().agents.forScope(scope()).update(agentId, { runtimeProfileId: null });
    if (cleared.kind !== 'updated') throw new Error(`expected updated, got ${cleared.kind}`);

    await expect(push()).resolves.toMatchObject({ runtimeProfileId: setup.runtimeProfileId });
    await expect(db().agents.forScope(scope()).get(agentId)).resolves.toMatchObject({
      runtimeProfileId: setup.runtimeProfileId,
    });
  });

  it('repairs its own row whose secret is gone, keeping the connection id', async () => {
    const first = await complete(setupInput());
    if (!first.ok) throw new Error(`setup refused: ${first.code}`);
    for (const secret of await secrets.list(scope())) await secrets.delete(scope(), secret.id);
    expect((await snapshot()).connections[0]).toMatchObject({ ready: false, credential: null });

    const repaired = await complete(setupInput({ providerApiKey: GOOD_KEY_2 }));
    if (!repaired.ok) throw new Error(`setup refused: ${repaired.code}`);
    expect(repaired.modelConnectionId).toBe(first.modelConnectionId);
    expect((await snapshot()).connections).toEqual([
      { id: first.modelConnectionId, name: CONNECTION_NAME, ready: true, credential: GOOD_KEY_2 },
    ]);
  });
}
