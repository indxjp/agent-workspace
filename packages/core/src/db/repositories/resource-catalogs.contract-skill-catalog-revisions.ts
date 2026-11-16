import { expect, it } from 'vitest';
import { noWrite, skillInput } from './resource-catalogs.contract-skill-catalog-fixtures.js';

import type { SkillCatalogConformanceFixture } from './resource-catalogs.contract-fixture.js';
export function registerSkillRevisionsTests(
  makeFixture: () => Promise<SkillCatalogConformanceFixture>,
): void {
  // @story US-STO-08
  it('[US-STO-08][contract][sdk] revisions number 1, 2, 3 per skill and list newest first', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await a.putSkill(skillInput('numbered', ownerA));
    await a.putSkill(skillInput('numbered-other', ownerA));
    const written: number[] = [];
    const write = (number: number) => {
      written.push(number);
      return Promise.resolve(undefined);
    };

    const first = await a.publishSkillRevision('numbered', { fileCount: 1, write });
    const second = await a.publishSkillRevision('numbered', { fileCount: 3, write });
    const third = await a.publishSkillRevision('numbered', { fileCount: 2, write });
    const other = await a.publishSkillRevision('numbered-other', {
      fileCount: 1,
      write: noWrite,
    });

    expect([first?.number, second?.number, third?.number, other?.number]).toEqual([1, 2, 3, 1]);
    expect(written).toEqual([1, 2, 3]);
    const revisions = await a.listSkillRevisions('numbered');
    expect(revisions.map((r) => [r.number, r.fileCount])).toEqual([
      [3, 2],
      [2, 3],
      [1, 1],
    ]);
    expect(revisions[0]?.publishedAt).toBeInstanceOf(Date);
  });

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] a throwing write records nothing and the number is reused', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await a.putSkill(skillInput('flaky', ownerA));
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

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] a stale revision number is never reused and completing it changes nothing', async () => {
    const { catalog, ownerA, ageRevisions } = await makeFixture();
    const a = catalog('a');
    await a.putSkill(skillInput('stale', ownerA));
    let started!: () => void;
    const writing = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const slow = a.publishSkillRevision('stale', {
      fileCount: 1,
      write: async () => {
        started();
        await released;
        return { skillMd: '# abandoned', enabled: false };
      },
    });
    await writing;
    await ageRevisions('stale');

    const abandonedSeen: (readonly number[])[] = [];
    const next = await a.publishSkillRevision('stale', {
      fileCount: 2,
      write: (_number, abandoned) => {
        abandonedSeen.push(abandoned);
        return Promise.resolve(undefined);
      },
    });
    expect(next?.number).toBe(2);
    expect(abandonedSeen).toEqual([[1]]);

    release();
    await expect(slow).resolves.toBeNull();
    expect((await a.listSkillRevisions('stale')).map((r) => [r.number, r.fileCount])).toEqual([
      [2, 2],
    ]);
    await expect(a.listSkills()).resolves.toMatchObject([
      { name: 'stale', skillMd: '# stale', enabled: true },
    ]);
  });

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] a revision is not listed until its write completes', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await a.putSkill(skillInput('pending', ownerA));
    const listedDuringWrite: number[][] = [];
    const revision = await a.publishSkillRevision('pending', {
      fileCount: 1,
      write: async () => {
        listedDuringWrite.push((await a.listSkillRevisions('pending')).map((r) => r.number));
        listedDuringWrite.push(
          (await a.listSkillRevisions('pending', { includePending: true })).map((r) => r.number),
        );
        return undefined;
      },
    });
    expect(listedDuringWrite).toEqual([[], [1]]);
    expect(revision?.number).toBe(1);
    expect((await a.listSkillRevisions('pending')).map((r) => r.number)).toEqual([1]);
  });

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] the content a write returns is stamped on the skill row', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await a.putSkill(skillInput('stamped', ownerA));
    await a.publishSkillRevision('stamped', {
      fileCount: 1,
      write: () => Promise.resolve({ skillMd: '# published', enabled: false }),
    });
    await expect(a.listSkills()).resolves.toMatchObject([
      { name: 'stamped', skillMd: '# published', enabled: false },
    ]);
  });

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] concurrent publishes of one skill get distinct numbers', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await a.putSkill(skillInput('concurrent', ownerA));
    const published = await Promise.all(
      Array.from({ length: 5 }, () =>
        a.publishSkillRevision('concurrent', { fileCount: 1, write: noWrite }),
      ),
    );
    expect(published.map((r) => r?.number).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] an unknown skill publishes nothing and has no revisions', async () => {
    const { catalog } = await makeFixture();
    const a = catalog('a');
    await expect(
      a.publishSkillRevision('missing', { fileCount: 1, write: noWrite }),
    ).resolves.toBeNull();
    await expect(a.listSkillRevisions('missing')).resolves.toEqual([]);
  });

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] revisions leave with their skill, so a recreated skill restarts at 1', async () => {
    const { catalog, ownerA } = await makeFixture();
    const a = catalog('a');
    await a.putSkill(skillInput('recreated', ownerA));
    await a.publishSkillRevision('recreated', { fileCount: 1, write: noWrite });
    await a.publishSkillRevision('recreated', { fileCount: 1, write: noWrite });
    await expect(a.deleteSkill('recreated')).resolves.toMatchObject({ kind: 'deleted' });
    await expect(a.listSkillRevisions('recreated')).resolves.toEqual([]);

    await a.putSkill(skillInput('recreated', ownerA));
    await expect(
      a.publishSkillRevision('recreated', { fileCount: 1, write: noWrite }),
    ).resolves.toMatchObject({ number: 1 });
  });

  // @story US-STO-08
  it('[US-STO-08][contract][sdk] another workspace cannot list, delete or publish to a skill', async () => {
    const { catalog, ownerA, ownerB } = await makeFixture();
    const a = catalog('a');
    const b = catalog('b');
    const skill = await a.putSkill(skillInput('private', ownerA));
    await a.publishSkillRevision('private', { fileCount: 1, write: noWrite });

    await expect(b.listSkills()).resolves.toEqual([]);
    await expect(b.deleteSkill('private')).resolves.toEqual({ kind: 'not-found' });
    await expect(
      b.publishSkillRevision('private', { fileCount: 1, write: noWrite }),
    ).resolves.toBeNull();
    await expect(b.listSkillRevisions('private')).resolves.toEqual([]);

    const inB = await b.putSkill(skillInput('private', ownerB));
    expect(inB.id).not.toBe(skill.id);
    await expect(a.listSkills()).resolves.toEqual([skill]);
    expect(await a.listSkillRevisions('private')).toHaveLength(1);
  });
}
