/** A copy into the verification workspace, made for its Owner. */
import { describe, expect, it } from 'vitest';

import type { DemoRunLimits } from './ports';
import { DEMO_MODEL_CONNECTION_NAME, DEMO_RUNTIME_PROFILE_NAME } from './template-copy';
import {
  NO_LIMITS,
  NOW,
  SPEC,
  type DemoTemplatesWorld,
  type MakeDemoTemplatesWorld,
} from './templates.contract-world';
import type { DemoEntrySlug } from '@indx-workspace/contracts/demo';

export function describeVerificationCopy(make: MakeDemoTemplatesWorld): void {
  describe('a copy into the verification workspace', () => {
    const verify = (
      world: DemoTemplatesWorld,
      entry: DemoEntrySlug,
      owner: { workspaceId: string; userId: string },
      limits: DemoRunLimits = NO_LIMITS,
    ) =>
      world.templates.copyIntoVerification({
        entry,
        workspaceId: owner.workspaceId,
        ownerUserId: owner.userId,
        limits,
        now: NOW,
      });

    it("is a visitor's copy made for the Owner: stand-ins, no-internet sandbox, the demo key, the caps", async () => {
      const world = await make();
      const entry = world.entry('verify');
      await world.seedTemplate(entry, {
        ...SPEC,
        connectors: [{ kind: 'declared', name: 'erp', reads: [], writes: ['createQuote'] }],
      });
      const owner = await world.newWorkspace();
      await verify(world, entry, owner, { maxTurns: 5, maxBudgetUsd: 0.2 });
      const [agent, ...rest] = await world.agents(owner.workspaceId);
      expect(rest).toEqual([]);
      expect(agent).toMatchObject({ name: SPEC.agent.name, modelConnectionId: null });
      expect(agent?.policy?.limits).toEqual({ maxTurns: 5, maxBudgetUsd: 0.2 });
      expect(await world.granted(owner.workspaceId, agent?.id ?? '')).toEqual([owner.principalId]);
      const [profile, ...otherProfiles] = await world.profiles(owner.workspaceId);
      expect(otherProfiles).toEqual([]);
      expect(profile).toMatchObject({ name: DEMO_RUNTIME_PROFILE_NAME, networkPolicy: 'none' });
      expect(agent?.runtimeProfileId).toBe(profile?.id);
      const [connection] = await world.models(owner.workspaceId).list();
      expect(connection).toMatchObject({
        name: DEMO_MODEL_CONNECTION_NAME,
        provider: 'anthropic',
      });
      const [erp] = await world.connectors(owner.workspaceId);
      expect(erp).toMatchObject({ name: 'erp', transport: 'stdio', url: null });
      expect(await world.fileText(owner.workspaceId, 'deals/q1.csv')).toBe('id,amount\n1,100\n');
      expect(await world.fileText(owner.workspaceId, 'private/secrets.txt')).toBeNull();
    });

    it('is made only for an Owner: a guest, or a member who is not one, gets nothing', async () => {
      const world = await make();
      const entry = world.entry('verify-guest');
      await world.seedTemplate(entry, SPEC);
      const guest = await world.newGuest();
      await expect(verify(world, entry, guest)).rejects.toThrow(/no owner membership/u);
      expect(await world.agents(guest.workspaceId)).toEqual([]);
    });
  });
}
