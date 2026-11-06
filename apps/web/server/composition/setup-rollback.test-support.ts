import { agents } from '@agent-workspace/core/db/unscoped';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { log as webLogger } from '../telemetry/logger';
import {
  adminUserId,
  complete,
  db,
  expectUntouched,
  isolated,
  scope,
  SEEDED_MODEL,
  setupInput,
  snapshot,
  withFailingRoot,
  workspace,
} from './setup-fixture.test-support';
import { GOOD_KEY, GOOD_KEY_2 } from './setup-provider.test-support';

export function registerRollbackTests(): void {
  it('a write refused part-way is rolled back, and a rollback step that fails is logged by label', async () => {
    // The workspace default is the last write but one: the connection, profile, agent and setup
    // mark have landed when it is refused. One undo step is made to fail as well.
    const live = db();
    const logged = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    await withFailingRoot(
      {
        setWorkspaceModelDefault: (workspaceId, value) =>
          value === null
            ? live.setWorkspaceModelDefault(workspaceId, null)
            : Promise.resolve(false),
        clearWorkspaceSetupAgentId: () => Promise.resolve(false),
      },
      async () => {
        expect(await complete(setupInput())).toMatchObject({
          ok: false,
          status: 500,
          code: 'workspace_default_reconciliation_failed',
        });
      },
    );
    // Deleting the agent the attempt created took its mark with it, so nothing remains.
    await expectUntouched();
    expect(logged.mock.calls).toEqual([
      [
        '[setup] rolling back a refused setup attempt left writes in place',
        { failed: [expect.stringMatching(/^clear setup mark on agent [0-9a-f-]{36}$/u)] },
      ],
    ]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain(GOOD_KEY);
  });

  it('never overwrites a built-in agent that carries the name the wizard was given', async () => {
    const repository = db().agents.forScope(scope());
    const builder = await repository.create({
      name: 'builder',
      instructions: 'The shipped Builder.',
      modelConnectionId: null,
      model: null,
      runtimeProfileId: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      ownerPrincipalId: (await repository.list())[0]?.ownerPrincipalId ?? '',
      createdBy: adminUserId,
    });
    if (builder.kind !== 'created') throw new Error(`fixture agent: ${builder.kind}`);
    if (isolated === undefined) throw new Error('the isolated database is not open');
    await isolated.db
      .update(agents)
      .set({ builtinKey: 'builder' })
      .where(eq(agents.id, builder.agent.id));
    const before = await repository.get(builder.agent.id);

    expect(await complete(setupInput({ agentName: 'builder' }))).toMatchObject({
      ok: false,
      status: 409,
      code: 'name-conflict',
    });

    expect(await repository.get(builder.agent.id)).toEqual(before);
    expect(before?.builtin).toBe('builder');
  });

  it('a refused re-run gives the setup mark back to the agent that had it', async () => {
    const first = await complete(setupInput());
    if (!first.ok) throw new Error(`setup refused: ${first.code}`);
    // An agent the administrator made, which a re-run of the wizard then names.
    const repository = db().agents.forScope(scope());
    const general = (await repository.list()).find((agent) => agent.name === 'General');
    const other = await repository.create({
      name: 'Researcher',
      instructions: 'Research.',
      modelConnectionId: null,
      model: null,
      runtimeProfileId: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      ownerPrincipalId: general?.ownerPrincipalId ?? '',
      createdBy: adminUserId,
    });
    if (other.kind !== 'created') throw new Error(`fixture agent: ${other.kind}`);
    const before = await snapshot();

    // The re-run reads a broken default, so it must write one, and that write is refused.
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    await withFailingRoot(
      {
        getWorkspaceModelDefault: () =>
          Promise.resolve({ connectionId: crypto.randomUUID(), model: SEEDED_MODEL }),
        setWorkspaceModelDefault: () => Promise.resolve(false),
      },
      async () => {
        expect(await complete(setupInput({ agentName: 'Researcher' }))).toMatchObject({
          ok: false,
          code: 'workspace_default_reconciliation_failed',
        });
      },
    );
    expect(await db().getWorkspaceSetupAgentId(workspace.id)).toBe(first.agentId);
    expect(await snapshot()).toEqual(before);
    // The attempt's own mark on Researcher is taken back, not merely outranked.
    if (isolated === undefined) throw new Error('the isolated database is not open');
    const [researcher] = await isolated.db
      .select({ setupConfiguredAt: agents.setupConfiguredAt })
      .from(agents)
      .where(eq(agents.id, other.agent.id));
    expect(researcher).toEqual({ setupConfiguredAt: null });
  });

  it('a refused re-run with a new key keeps the old key, and restores the profile and agent', async () => {
    const first = await complete(setupInput());
    if (!first.ok) throw new Error(`setup refused: ${first.code}`);
    // What an administrator changed since: the profile's limits and the agent's instructions.
    const profiles = db().runtimeProfiles.forScope(scope());
    expect((await profiles.update(first.runtimeProfileId, { cpu: 2, memoryMb: 2048 })).kind).toBe(
      'updated',
    );
    const repository = db().agents.forScope(scope());
    expect((await repository.update(first.agentId, { instructions: 'Edited.' })).kind).toBe(
      'updated',
    );
    const before = await snapshot();
    const profileBefore = await profiles.get(first.runtimeProfileId);
    const agentBefore = await repository.get(first.agentId);

    // The setup mark is the late write that fails, after the key, profile and agent were written.
    await withFailingRoot({ setWorkspaceSetupAgentId: () => Promise.resolve(false) }, async () => {
      expect(
        await complete(setupInput({ providerApiKey: GOOD_KEY_2, agentInstructions: 'New.' })),
      ).toMatchObject({ ok: false, code: 'setup_agent_missing' });
    });
    expect(await snapshot()).toEqual(before);
    expect(before.connections[0]?.credential).toBe(GOOD_KEY);
    expect(await profiles.get(first.runtimeProfileId)).toMatchObject({
      cpu: 2,
      memoryMb: 2048,
      networkPolicy: profileBefore?.networkPolicy,
    });
    expect(await repository.get(first.agentId)).toMatchObject({
      instructions: 'Edited.',
      model: agentBefore?.model,
      modelConnectionId: agentBefore?.modelConnectionId,
    });
  });
}
