/** The sandbox profile and the model connection a copy gives the workspace. */
import { describe, expect, it } from 'vitest';

import { grantsFor } from '../../identity';
import { DEMO_MODEL_CONNECTION_NAME, DEMO_RUNTIME_PROFILE_NAME } from './template-copy';
import {
  SPEC,
  TEST_DEMO_API_KEY,
  copy,
  type MakeDemoTemplatesWorld,
} from './templates.contract-world';

export function describeSandboxAndModel(make: MakeDemoTemplatesWorld): void {
  describe('the sandbox and the model of a copy', () => {
    it('gives the workspace ONE sandbox profile with no network, and the agent runs in it', async () => {
      const world = await make();
      const entry = world.entry('sandbox');
      await world.seedTemplate(entry, SPEC);
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      const profiles = await world.profiles(guest.workspaceId);
      expect(profiles).toHaveLength(1);
      expect(profiles[0]).toMatchObject({
        name: DEMO_RUNTIME_PROFILE_NAME,
        driver: 'docker',
        networkPolicy: 'none',
        allowedDomains: null,
        runtimeConnectionId: null,
      });
      const [agent] = await world.agents(guest.workspaceId);
      expect(agent?.runtimeProfileId).toBe(profiles[0]?.id);
    });

    it('makes the profile once however often the workspace is copied into, across entries too', async () => {
      const world = await make();
      const first = world.entry('profile-one');
      const second = world.entry('profile-two');
      await world.seedTemplate(first, SPEC);
      await world.seedTemplate(second, {
        ...SPEC,
        agent: { ...SPEC.agent, name: 'ops-helper' },
      });
      const guest = await world.newGuest();
      await copy(world, first, guest);
      await copy(world, first, guest);
      await copy(world, second, guest);
      const profiles = await world.profiles(guest.workspaceId);
      expect(profiles).toHaveLength(1);
      for (const agent of await world.agents(guest.workspaceId)) {
        expect(agent.runtimeProfileId).toBe(profiles[0]?.id);
      }
    });

    it('sets a profile that is not closed back to none, and attaches it to an agent a first copy left bare', async () => {
      const world = await make();
      const entry = world.entry('reset');
      await world.seedTemplate(entry, SPEC);
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      const [profile] = await world.profiles(guest.workspaceId);
      await world.profileStore(guest.workspaceId).update(profile?.id ?? '', {
        networkPolicy: 'open',
        allowedDomains: ['example.test'],
      });
      const [agent] = await world.agents(guest.workspaceId);
      await world.detachProfile(guest.workspaceId, agent?.id ?? '');
      await copy(world, entry, guest);
      const [after] = await world.profiles(guest.workspaceId);
      expect(after).toMatchObject({ networkPolicy: 'none', allowedDomains: null });
      expect((await world.agents(guest.workspaceId))[0]?.runtimeProfileId).toBe(after?.id);
    });

    it('has no profile when the deployment names no runtime driver, so a run cannot start', async () => {
      const world = await make({ runtimeDriver: null });
      const entry = world.entry('no-driver');
      await world.seedTemplate(entry, SPEC);
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      expect(await world.profiles(guest.workspaceId)).toEqual([]);
      expect((await world.agents(guest.workspaceId))[0]?.runtimeProfileId).toBeNull();
    });

    it('gives the workspace a default Anthropic connection holding the deployment key, once', async () => {
      const world = await make();
      const entry = world.entry('model');
      await world.seedTemplate(entry, SPEC);
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      await copy(world, entry, guest);
      const store = world.models(guest.workspaceId);
      const connections = await store.list();
      expect(connections).toHaveLength(1);
      expect(connections[0]).toMatchObject({
        name: DEMO_MODEL_CONNECTION_NAME,
        provider: 'anthropic',
      });
      // The key is stored (a run resolves it on the server), and is the deployment's.
      expect((await store.resolve(connections[0]?.id ?? ''))?.credential).toBe(TEST_DEMO_API_KEY);
      // The agent names no connection: it runs on the workspace's `default`.
      expect((await world.agents(guest.workspaceId))[0]?.modelConnectionId).toBeNull();
    });

    it('shows the key nowhere a guest can read: not in the connection, the agent, the connectors or the profile', async () => {
      const world = await make();
      const entry = world.entry('hidden');
      await world.seedTemplate(entry, {
        ...SPEC,
        connectors: [{ kind: 'mcp', name: 'mailer' }],
      });
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      const everything = JSON.stringify([
        await world.models(guest.workspaceId).list(),
        await world.agents(guest.workspaceId),
        await world.connectors(guest.workspaceId),
        await world.profiles(guest.workspaceId),
      ]);
      expect(everything).not.toContain(TEST_DEMO_API_KEY);
      expect(everything).not.toContain('sk-ant');
    });

    it.each(['model-connections', 'secrets', 'runtime-profiles', 'runtimes'] as const)(
      'gives the guest role no grant on %s, so it cannot read the connection, the secret or the profile',
      (resource) => {
        expect(grantsFor('guest', resource)).toEqual({
          read: 'none',
          write: 'none',
          run: 'none',
        });
      },
    );

    it('makes no connection when the deployment has no key, and still the sandbox', async () => {
      const world = await make({ anthropicApiKey: null });
      const entry = world.entry('no-key');
      await world.seedTemplate(entry, SPEC);
      const guest = await world.newGuest();
      await copy(world, entry, guest);
      expect(await world.models(guest.workspaceId).list()).toEqual([]);
      expect(await world.profiles(guest.workspaceId)).toHaveLength(1);
    });

    it('makes nothing of the sandbox or the model for an entry that has no template', async () => {
      const world = await make();
      const guest = await world.newGuest();
      await expect(copy(world, world.entry('absent'), guest)).rejects.toThrow(/no demo template/u);
      expect(await world.profiles(guest.workspaceId)).toEqual([]);
      expect(await world.models(guest.workspaceId).list()).toEqual([]);
    });
  });
}
