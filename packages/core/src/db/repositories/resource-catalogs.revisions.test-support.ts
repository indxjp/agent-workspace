import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { agentSkills } from '../schema/agent-skills.js';
import { agents } from '../schema/agents.js';
import { skillRevisions } from '../schema/skill-revisions.js';
import {
  isolated,
  principalA,
  scopeA,
  scopeB,
  userA,
} from './resource-catalogs.fixture.test-support.js';
import { createDatabaseResourceCatalogRepositoryProvider } from './resource-catalogs.js';

export function describeCatalogRevisionTests(): void {
  describe('skill revisions (SDK-19, N-1)', () => {
    const skillInput = (name: string) => ({
      name,
      skillMd: `# ${name}`,
      enabled: true,
      ownerPrincipalId: principalA,
      createdBy: userA,
    });
    const noWrite = () => Promise.resolve(undefined);

    it('numbers revisions 1, 2, 3 per skill, lists newest first and hides them from other workspaces', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const b = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeB);
      await a.putSkill(skillInput('numbered'));
      await a.putSkill(skillInput('numbered-other'));
      const written: number[] = [];
      const write = (n: number) => {
        written.push(n);
        return Promise.resolve(undefined);
      };
      const first = await a.publishSkillRevision('numbered', { fileCount: 1, write });
      const second = await a.publishSkillRevision('numbered', { fileCount: 3, write });
      const other = await a.publishSkillRevision('numbered-other', {
        fileCount: 1,
        write: noWrite,
      });
      expect([first?.number, second?.number, other?.number]).toEqual([1, 2, 1]);
      expect(written).toEqual([1, 2]);
      expect((await a.listSkillRevisions('numbered')).map((r) => [r.number, r.fileCount])).toEqual([
        [2, 3],
        [1, 1],
      ]);
      await expect(b.listSkillRevisions('numbered')).resolves.toEqual([]);
      await expect(
        b.publishSkillRevision('numbered', { fileCount: 1, write: noWrite }),
      ).resolves.toBeNull();
      await expect(
        a.publishSkillRevision('missing', { fileCount: 1, write: noWrite }),
      ).resolves.toBeNull();
    });

    it('gives concurrent publishes distinct numbers', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      await a.putSkill(skillInput('concurrent'));
      const published = await Promise.all(
        Array.from({ length: 5 }, () =>
          a.publishSkillRevision('concurrent', { fileCount: 1, write: noWrite }),
        ),
      );
      expect(published.map((r) => r?.number).sort()).toEqual([1, 2, 3, 4, 5]);
    });

    it('records nothing and reuses the number when the object-store write fails', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      await a.putSkill(skillInput('flaky'));
      await expect(
        a.publishSkillRevision('flaky', {
          fileCount: 1,
          write: () => Promise.reject(new Error('store down')),
        }),
      ).rejects.toThrow('store down');
      await expect(a.listSkillRevisions('flaky')).resolves.toEqual([]);
      await expect(
        a.publishSkillRevision('flaky', { fileCount: 1, write: noWrite }),
      ).resolves.toMatchObject({ number: 1 });
    });

    it('refuses a second row for a published number and leaves the row alone when the skill changes', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const skill = await a.putSkill(skillInput('frozen-row'));
      const first = await a.publishSkillRevision('frozen-row', { fileCount: 2, write: noWrite });
      await expect(
        isolated.db
          .insert(skillRevisions)
          .values({ workspaceId: scopeA.workspaceId, skillId: skill.id, number: 1, fileCount: 9 }),
      ).rejects.toThrow();

      await a.putSkill({ ...skillInput('frozen-row'), skillMd: '# changed', enabled: false });
      const second = await a.publishSkillRevision('frozen-row', { fileCount: 5, write: noWrite });
      expect(second?.number).toBe(2);
      expect(await a.listSkillRevisions('frozen-row')).toEqual([second, first]);
    });

    it('lets an assignment pin only a revision that exists, and cascades revisions with the skill', async () => {
      const a = createDatabaseResourceCatalogRepositoryProvider(isolated.db).forScope(scopeA);
      const skill = await a.putSkill(skillInput('pinned'));
      await a.publishSkillRevision('pinned', { fileCount: 1, write: noWrite });
      const agentId = crypto.randomUUID();
      await isolated.db.insert(agents).values({
        id: agentId,
        workspaceId: scopeA.workspaceId,
        name: 'Pinning agent',
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions: {
          readFiles: false,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
        ownerPrincipalId: principalA,
        createdBy: userA,
      });
      const assignment = { workspaceId: scopeA.workspaceId, agentId, skillId: skill.id };
      await expect(
        isolated.db.insert(agentSkills).values({ ...assignment, revision: 2 }),
      ).rejects.toThrow();
      await isolated.db.insert(agentSkills).values({ ...assignment, revision: 1 });
      await expect(a.deleteSkill('pinned')).resolves.toMatchObject({ kind: 'in-use' });

      await isolated.db.delete(agentSkills).where(eq(agentSkills.skillId, skill.id));
      await expect(a.deleteSkill('pinned')).resolves.toMatchObject({ kind: 'deleted' });
      await expect(
        isolated.db.select().from(skillRevisions).where(eq(skillRevisions.skillId, skill.id)),
      ).resolves.toEqual([]);
    });
  });
}
