import { describe, expect, it } from 'vitest';
import { type createAgentVersionFixture } from './agent-versions.fixture.test-support.js';
export function registerCompareAndSetCases(fixture: ReturnType<typeof createAgentVersionFixture>) {
  const { userB, principalB, seedAgent, version, materialise, auditBy, auditRows, snapshot } =
    fixture;

  describe('compare-and-set on a pointer move (#1847)', () => {
    /** An agent with versions 1..3 and `local` pointed at version 1. */
    async function agentAtVersionOne(name: string): Promise<string> {
      const agentId = await seedAgent(name);
      await version(agentId);
      await version(agentId);
      await version(agentId);
      const seeded = await fixture.repoA.applyAndPoint(agentId, {
        reason: 'set',
        environment: 'local',
        number: 1,
        agent: materialise({ name }),
        audit: auditBy(),
      });
      expect(seeded.kind).toBe('applied');
      return agentId;
    }

    const moveLocal = (
      agentId: string,
      name: string,
      number: number,
      expectedVersion?: number | null,
    ) =>
      fixture.repoA.applyAndPoint(agentId, {
        reason: 'set',
        environment: 'local',
        number,
        agent: materialise({ name }),
        audit: auditBy(),
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      });

    it('moves local once when two moves both expect the same version', async () => {
      const agentId = await agentAtVersionOne('cas-concurrent');
      const [toTwo, toThree] = await Promise.all([
        moveLocal(agentId, 'cas-concurrent', 2, 1),
        moveLocal(agentId, 'cas-concurrent', 3, 1),
      ]);

      const outcomes = [toTwo, toThree];
      const applied = outcomes.filter((outcome) => outcome.kind === 'applied');
      expect(applied).toHaveLength(1);
      const winner = applied[0];
      if (winner?.kind !== 'applied') throw new Error('one move should have applied');
      expect(outcomes.filter((outcome) => outcome.kind !== 'applied')).toEqual([
        { kind: 'pointer-moved', current: winner.pointer.number },
      ]);

      const rows = await snapshot(agentId);
      expect(rows.pointerRows.map((row) => row.versionId)).toEqual([winner.pointer.versionId]);
      // The seed move plus the winner's: the refused move appended nothing.
      expect(rows.moveRows).toHaveLength(2);
      expect(await auditRows(agentId)).toHaveLength(2);
    });

    it('refuses a stale expectation, changes nothing, and leaves the new version unpointed', async () => {
      const agentId = await agentAtVersionOne('cas-stale');
      const before = await snapshot(agentId);
      const auditsBefore = await auditRows(agentId);

      await expect(moveLocal(agentId, 'cas-stale', 3, 2)).resolves.toEqual({
        kind: 'pointer-moved',
        current: 1,
      });

      expect(await snapshot(agentId)).toEqual(before);
      expect(await auditRows(agentId)).toEqual(auditsBefore);
      // §08 Data rule 2: the version a refused move was about to point at stays saved, unpointed.
      const listed = await fixture.repoA.list(agentId);
      expect(listed?.versions.map((row) => row.number)).toEqual([1, 2, 3]);
      expect(listed?.pointers.map((row) => row.number)).toEqual([1]);
    });

    it('applies when the expectation holds, and when it is absent', async () => {
      const agentId = await agentAtVersionOne('cas-holds');
      await expect(moveLocal(agentId, 'cas-holds', 2, 1)).resolves.toMatchObject({
        kind: 'applied',
        pointer: { number: 2 },
      });
      await expect(moveLocal(agentId, 'cas-holds', 3)).resolves.toMatchObject({
        kind: 'applied',
        pointer: { number: 3 },
      });
    });

    it('reads null as "the pointer must be unset"', async () => {
      const unset = await seedAgent('cas-null-unset');
      await version(unset);
      await expect(moveLocal(unset, 'cas-null-unset', 1, null)).resolves.toMatchObject({
        kind: 'applied',
      });
      await expect(moveLocal(unset, 'cas-null-unset', 1, null)).resolves.toEqual({
        kind: 'pointer-moved',
        current: 1,
      });
    });

    it('checks the environment being moved, not local', async () => {
      const agentId = await agentAtVersionOne('cas-production');
      const promote = (expectedVersion: number | null) =>
        fixture.repoA.applyAndPoint(agentId, {
          reason: 'promote',
          environment: 'production',
          number: 1,
          agent: materialise({ name: 'cas-production' }),
          audit: auditBy(),
          expectedVersion,
        });
      await expect(promote(1)).resolves.toEqual({ kind: 'pointer-moved', current: null });
      await expect(promote(null)).resolves.toMatchObject({ kind: 'applied' });
    });

    it('answers not-found for another workspace’s agent before comparing', async () => {
      const agentId = await agentAtVersionOne('cas-scoped');
      await expect(
        fixture.repoB.applyAndPoint(agentId, {
          reason: 'set',
          environment: 'local',
          number: 1,
          agent: materialise({}),
          audit: auditBy({ actorPrincipalId: principalB, actorUserId: userB }),
          expectedVersion: 2,
        }),
      ).resolves.toEqual({ kind: 'not-found' });
    });
  });
}
