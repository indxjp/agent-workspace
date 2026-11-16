/**
 * The skills port's contract (`./ports.ts`), written against the port and not against any adapter.
 * `store.test.ts` runs it on the in-memory catalog and `store.postgres.test.ts` on PostgreSQL; both
 * passing is the reason to believe the two adapters are the same thing (refactoring plan part 07,
 * steps 5–6). It pins what the skills code relies on; the catalog's own conformance suite in
 * `packages/core` covers the rest.
 */
import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { SkillCatalog, SkillRow, SkillRowInput } from './ports';

export interface SkillCatalogFixture {
  /** Workspace `a`'s and workspace `b`'s port. */
  readonly catalog: (workspace: 'a' | 'b') => SkillCatalog;
  /** A principal of workspace `a`. */
  readonly ownerA: string;
  /** Assign the skill to a new agent of workspace `a`; answers the agent's id. */
  readonly assign: (skill: SkillRow) => Promise<string>;
}

const input = (name: string, ownerPrincipalId: string, skillMd = `# ${name}`): SkillRowInput => ({
  name,
  skillMd,
  enabled: true,
  ownerPrincipalId,
});

const noBytes = () => Promise.resolve(undefined);

export function describeSkillCatalogContract(
  label: string,
  make: () => Promise<SkillCatalogFixture>,
): void {
  describe(`skills port: ${label}`, () => {
    it('lists and gets a row as it was put, and keeps its id and owner on a second put', async () => {
      const { catalog, ownerA } = await make();
      const port = catalog('a');
      const put = await port.putSkill(input('triage', ownerA));
      expect(put).toMatchObject({
        name: 'triage',
        skillMd: '# triage',
        enabled: true,
        ownerPrincipalId: ownerA,
        pendingDelete: null,
        builtinDigest: null,
        meta: null,
      });
      expect(await port.getSkill('triage')).toEqual(put);
      expect(await port.listSkills()).toEqual([put]);
      expect(await port.getSkill('missing')).toBeNull();

      const again = await port.putSkill({ ...input('triage', crypto.randomUUID(), '# v2') });
      expect(again).toMatchObject({ id: put.id, ownerPrincipalId: ownerA, skillMd: '# v2' });
    });

    it('creates a row only when the name is free', async () => {
      const { catalog, ownerA } = await make();
      const port = catalog('a');
      const created = await port.createSkill(input('report', ownerA));
      expect(created?.name).toBe('report');
      expect(await port.createSkill(input('report', ownerA))).toBeNull();
    });

    it('keeps each workspace to its own rows', async () => {
      const { catalog, ownerA } = await make();
      await catalog('a').putSkill(input('private', ownerA));
      expect(await catalog('b').listSkills()).toEqual([]);
      expect(await catalog('b').getSkill('private')).toBeNull();
    });

    it('deletes a row, only with its own id when one is given, and never one in use', async () => {
      const { catalog, ownerA, assign } = await make();
      const port = catalog('a');
      const row = await port.putSkill(input('old', ownerA));
      expect(await port.deleteSkill('old', crypto.randomUUID())).toEqual({ kind: 'not-found' });
      expect(await port.getSkill('old')).not.toBeNull();

      const used = await port.putSkill(input('used', ownerA));
      const agentId = await assign(used);
      expect(await port.deleteSkill('used')).toEqual({ kind: 'in-use', agentIds: [agentId] });

      const deleted = await port.deleteSkill('old', row.id);
      expect(deleted).toMatchObject({ kind: 'deleted', skill: { id: row.id } });
      expect(await port.getSkill('old')).toBeNull();
      expect(await port.deleteSkill('old')).toEqual({ kind: 'not-found' });
    });

    it('marks a delete with the owner and revisions, refuses one in use, and backfills a legacy mark', async () => {
      const { catalog, ownerA, assign } = await make();
      const port = catalog('a');
      await port.putSkill(input('going', ownerA));
      await port.publishSkillRevision('going', { fileCount: 1, write: noBytes });
      expect(await port.markSkillDeleting('going')).toEqual({
        kind: 'marked',
        pending: { ownerPrincipalId: ownerA, revisions: [1] },
      });
      expect((await port.getSkill('going'))?.pendingDelete).toEqual({
        ownerPrincipalId: ownerA,
        revisions: [1],
      });
      expect(await port.markSkillDeleting('missing')).toEqual({ kind: 'not-found' });

      const used = await port.putSkill(input('kept', ownerA));
      const agentId = await assign(used);
      expect(await port.markSkillDeleting('kept')).toEqual({ kind: 'in-use', agentIds: [agentId] });
      const legacy = { ownerPrincipalId: null, revisions: [] };
      expect(await port.backfillSkillPendingDelete('kept', legacy)).toBe(false);

      await port.putSkill(input('legacy', ownerA));
      expect(await port.backfillSkillPendingDelete('legacy', legacy)).toBe(true);
      expect((await port.getSkill('legacy'))?.pendingDelete).toEqual(legacy);
      expect(await port.backfillSkillPendingDelete('missing', legacy)).toBe(false);
    });

    it('writes the platform record, only into an empty one with onlyIfEmpty, and the built-in digest', async () => {
      const { catalog, ownerA } = await make();
      const port = catalog('a');
      expect(await port.setSkillMeta('missing', { a: 1 })).toBe(false);
      await port.putSkill(input('meta', ownerA));
      expect(await port.setSkillMeta('meta', { first: true }, true)).toBe(true);
      // `true` names a row; with onlyIfEmpty a row that already has a record keeps it.
      expect(await port.setSkillMeta('meta', { second: true }, true)).toBe(true);
      expect((await port.getSkill('meta'))?.meta).toEqual({ first: true });
      expect(await port.setSkillMeta('meta', null)).toBe(true);
      expect((await port.getSkill('meta'))?.meta).toBeNull();

      await port.setSkillBuiltinDigest('meta', 'sha256:abc');
      expect((await port.getSkill('meta'))?.builtinDigest).toBe('sha256:abc');
    });

    it('numbers revisions from 1, lists them newest first, and updates the row from the write', async () => {
      const { catalog, ownerA } = await make();
      const port = catalog('a');
      expect(
        await port.publishSkillRevision('missing', { fileCount: 1, write: noBytes }),
      ).toBeNull();
      expect(await port.listSkillRevisions('missing')).toEqual([]);

      await port.putSkill(input('versioned', ownerA));
      const seen: number[] = [];
      const first = await port.publishSkillRevision('versioned', {
        fileCount: 2,
        write: (number) => {
          seen.push(number);
          return Promise.resolve(undefined);
        },
      });
      const second = await port.publishSkillRevision('versioned', {
        fileCount: 3,
        write: (number) => {
          seen.push(number);
          return Promise.resolve({ skillMd: '# versioned v2', enabled: false });
        },
      });
      expect(seen).toEqual([1, 2]);
      expect(first).toMatchObject({ number: 1, fileCount: 2 });
      expect(second).toMatchObject({ number: 2, fileCount: 3 });
      expect(second?.publishedAt).toBeInstanceOf(Date);
      expect((await port.listSkillRevisions('versioned')).map((r) => r.number)).toEqual([2, 1]);
      expect(await port.getSkill('versioned')).toMatchObject({
        skillMd: '# versioned v2',
        enabled: false,
      });
    });
  });
}
