import { describe, expect, it } from 'vitest';
import { utf8, type WithObjectStore } from './contract-fixture.js';
import { type ObjectStore } from './object-store.js';
export function defineListingContract(withStore: WithObjectStore): void {
  describe('listPage() pages with an opaque cursor', () => {
    async function drain(
      store: ObjectStore,
      prefix: string,
      recursive: boolean,
      limit: number,
    ): Promise<string[]> {
      const keys: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard += 1) {
        const page = await store.listPage(prefix, {
          recursive,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(page.entries.length).toBeLessThanOrEqual(Math.max(1, limit));
        keys.push(...page.entries.map((entry) => entry.key));
        if (page.cursor === null) return keys;
        cursor = page.cursor;
      }
      throw new Error('listPage never finished');
    }

    it('visits every entry once, one level or recursively', async () => {
      await withStore(async (store) => {
        for (const name of ['a', 'b', 'c', 'd', 'e']) {
          await store.write(`p/${name}.txt`, utf8(name), {});
        }
        await store.write('p/sub/deep.txt', utf8('deep'), {});
        await store.write('p-sibling/x.txt', utf8('x'), {});

        const level = await drain(store, 'p', false, 2);
        expect([...level].sort()).toEqual([
          'p/a.txt',
          'p/b.txt',
          'p/c.txt',
          'p/d.txt',
          'p/e.txt',
          'p/sub',
        ]);
        const deep = await drain(store, 'p', true, 2);
        expect([...deep].sort()).toEqual([
          'p/a.txt',
          'p/b.txt',
          'p/c.txt',
          'p/d.txt',
          'p/e.txt',
          'p/sub/deep.txt',
        ]);
      });
    });

    it('does not skip a folder that shares its key with a file across a page boundary', async () => {
      await withStore(async (store) => {
        if (!store.capabilities.fileAndFolderShareKey) return;
        await store.write('dup/x', utf8('file'), {});
        await store.write('dup/x/y', utf8('deep'), {});
        const keys: string[] = [];
        const kinds: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 10; guard += 1) {
          const page = await store.listPage('dup', {
            limit: 1,
            ...(cursor === undefined ? {} : { cursor }),
          });
          keys.push(...page.entries.map((entry) => entry.key));
          kinds.push(...page.entries.map((entry) => entry.kind));
          if (page.cursor === null) break;
          cursor = page.cursor;
        }
        expect(keys).toEqual(['dup/x', 'dup/x']);
        expect([...kinds].sort()).toEqual(['file', 'folder']);
      });
    });

    it('lists pages that concatenate into the single-page order, one level or recursively', async () => {
      await withStore(async (store) => {
        // A folder sorts next to files that share its name's start: `-` and `.` sort before `/`.
        for (const key of ['o/a.txt', 'o/a/b.txt', 'o/a-b/c.txt', 'o/a0.txt', 'o/b.txt']) {
          await store.write(key, utf8(key), {});
        }
        for (const recursive of [false, true]) {
          const whole = (await store.listPage('o', { recursive, limit: 1000 })).entries.map(
            (entry) => `${entry.kind}:${entry.key}`,
          );
          expect(whole).toHaveLength(5);
          for (const limit of [1, 2, 3]) {
            const paged: string[] = [];
            let cursor: string | undefined;
            for (let guard = 0; guard < 20; guard += 1) {
              const page = await store.listPage('o', {
                recursive,
                limit,
                ...(cursor === undefined ? {} : { cursor }),
              });
              paged.push(...page.entries.map((entry) => `${entry.kind}:${entry.key}`));
              if (page.cursor === null) break;
              cursor = page.cursor;
            }
            expect(paged).toEqual(whole);
          }
        }
      });
    });

    it('treats a limit below 1 as 1 and still finishes', async () => {
      await withStore(async (store) => {
        await store.write('lim/a.txt', utf8('a'), {});
        await store.write('lim/b.txt', utf8('b'), {});
        expect(await drain(store, 'lim', true, 0)).toEqual(['lim/a.txt', 'lim/b.txt']);
      });
    });

    it('returns an empty final page for a prefix with nothing under it', async () => {
      await withStore(async (store) => {
        expect(await store.listPage('none', {})).toEqual({ entries: [], cursor: null });
      });
    });
  });
}
