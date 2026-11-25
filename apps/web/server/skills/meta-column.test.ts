/**
 * The meta-column view pages the skill records of the catalog as one listing, and never reads an
 * object under `skill-meta/`. A walk over that listing reads the catalog once, not once per page.
 */
import { describe, expect, it, vi } from 'vitest';

import { createInMemoryCatalog } from '@agent-workspace/core/db/unscoped';
import { bytesToStream, createInMemoryObjectStore } from '@agent-workspace/core/storage';
import { listAll } from '@agent-workspace/core/storage/streams';

import { skillMetaKey, SKILL_META_PREFIX } from './keys';
import { withSkillMetaColumn } from './meta-column';

const SKILLS = 7;

async function seeded() {
  const catalog = createInMemoryCatalog().forWorkspace(crypto.randomUUID());
  const store = createInMemoryObjectStore();
  for (let index = 0; index < SKILLS; index += 1) {
    const name = `skill-${String(index)}`;
    await catalog.createSkill({
      name,
      skillMd: `---\nname: ${name}\n---\n`,
      enabled: true,
      ownerPrincipalId: crypto.randomUUID(),
    });
    await catalog.setSkillMeta(name, { name, enabled: true });
  }
  // An object an earlier release wrote under the prefix is neither listed nor read.
  const bytes = new TextEncoder().encode(JSON.stringify({ name: 'stray', enabled: true }));
  await store.write(skillMetaKey('stray'), bytesToStream(bytes), {
    contentType: 'application/json',
  });
  return { catalog, store };
}

describe('withSkillMetaColumn listPage', () => {
  it('[US-STO-08][unit][sdk] a paged walk lists every record and reads the skills once', async () => {
    const { catalog, store } = await seeded();
    const listSkills = vi.spyOn(catalog, 'listSkills');
    const storePages = vi.spyOn(store, 'listPage');
    const view = withSkillMetaColumn(store, catalog);

    const keys: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await view.listPage(SKILL_META_PREFIX, {
        limit: 2,
        ...(cursor === null ? {} : { cursor }),
      });
      keys.push(...page.entries.map((entry) => entry.key));
      cursor = page.cursor;
      pages += 1;
    } while (cursor !== null);

    expect(pages).toBe(Math.ceil(SKILLS / 2));
    expect(keys).toEqual(
      Array.from({ length: SKILLS }, (_, index) => skillMetaKey(`skill-${String(index)}`)),
    );
    expect(listSkills).toHaveBeenCalledTimes(1);
    expect(storePages).not.toHaveBeenCalled();
    expect(await view.read(skillMetaKey('stray'))).toBeNull();
  });

  it('[US-STO-08][unit][sdk] a new walk sees a record written after the previous walk', async () => {
    const { catalog, store } = await seeded();
    const view = withSkillMetaColumn(store, catalog);
    expect(await listAll(view, SKILL_META_PREFIX)).toHaveLength(SKILLS);

    await catalog.createSkill({
      name: 'late',
      skillMd: '---\nname: late\n---\n',
      enabled: true,
      ownerPrincipalId: crypto.randomUUID(),
    });
    await catalog.setSkillMeta('late', { name: 'late', enabled: true });

    expect(await listAll(view, SKILL_META_PREFIX)).toHaveLength(SKILLS + 1);
  });

  it('[US-STO-08][unit][sdk] two walks interleaved on one view each see their own listing', async () => {
    const { catalog, store } = await seeded();
    const view = withSkillMetaColumn(store, catalog);
    const first = await view.listPage(SKILL_META_PREFIX, { limit: 3 });
    const second = await view.listPage(SKILL_META_PREFIX, { limit: 3 });
    expect(first.cursor).not.toBeNull();
    expect(second.cursor).not.toBeNull();
    const rest = async (cursor: string | null): Promise<string[]> => {
      const keys: string[] = [];
      while (cursor !== null) {
        const page = await view.listPage(SKILL_META_PREFIX, { limit: 3, cursor });
        keys.push(...page.entries.map((entry) => entry.key));
        cursor = page.cursor;
      }
      return keys;
    };
    const [left, right] = await Promise.all([rest(first.cursor), rest(second.cursor)]);
    expect(left).toHaveLength(SKILLS - 3);
    expect(right).toEqual(left);
  });
});
