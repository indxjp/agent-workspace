import { describe, expect, it } from 'vitest';

import { createDemoWorkspaceFiles, type DemoStorage } from './storage';

const AREAS = ['files', 'skills', 'artifacts'] as const;

/** A storage fake: files by workspace and area, listed in pages of two with a cursor. */
function storageWith(files: Record<string, Partial<Record<string, string[]>>>) {
  const removed: string[] = [];
  const storage: DemoStorage = {
    list: (ctx, area, folder, page) => {
      expect(folder).toBe('');
      const all = files[ctx.workspaceId]?.[area] ?? [];
      const from = page?.cursor === undefined ? 0 : Number(page.cursor);
      const next = from + 2;
      return Promise.resolve({
        rows: all.slice(from, next).map((path) => ({ path })),
        cursor: next < all.length ? String(next) : null,
      });
    },
    remove: (ctx, area, path) => {
      removed.push(`${ctx.workspaceId}:${area}:${path}`);
      return Promise.resolve({ ok: true });
    },
  };
  return { storage, removed };
}

describe('the demo workspace files', () => {
  it('removes every file of every area of the workspace, across catalog pages', async () => {
    const { storage, removed } = storageWith({
      demo: { files: ['a.csv', 'b.csv', 'c.csv', 'd.csv', 'e.csv'], artifacts: ['out.pdf'] },
    });
    await createDemoWorkspaceFiles(storage, AREAS).removeAll('demo');
    expect(removed.sort()).toEqual(
      [
        'demo:files:a.csv',
        'demo:files:b.csv',
        'demo:files:c.csv',
        'demo:files:d.csv',
        'demo:files:e.csv',
        'demo:artifacts:out.pdf',
      ].sort(),
    );
  });

  it("touches no other workspace's files", async () => {
    const { storage, removed } = storageWith({
      demo: { files: ['mine.csv'] },
      other: { files: ['theirs.csv'] },
    });
    await createDemoWorkspaceFiles(storage, AREAS).removeAll('demo');
    expect(removed).toEqual(['demo:files:mine.csv']);
  });

  it('treats a file that is already gone as removed', async () => {
    const { storage } = storageWith({ demo: { files: ['a.csv'] } });
    storage.remove = () => Promise.resolve({ ok: false, code: 'not_found' });
    await expect(
      createDemoWorkspaceFiles(storage, AREAS).removeAll('demo'),
    ).resolves.toBeUndefined();
  });

  it('rejects when a file cannot be removed, naming the code and no path', async () => {
    const { storage } = storageWith({ demo: { files: ['secret-name.csv'] } });
    storage.remove = () => Promise.resolve({ ok: false, code: 'invalid_path' });
    await expect(createDemoWorkspaceFiles(storage, AREAS).removeAll('demo')).rejects.toThrow(
      'could not remove a demo workspace file (invalid_path)',
    );
  });
});
