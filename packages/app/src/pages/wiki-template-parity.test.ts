import { renderAppTemplate } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { createTableSql } from '../db/create-table-sql.js';
import { text } from '../fields/index.js';
import { defineResource } from '../resource.js';
import { definePages } from './define-pages.js';

// The wiki preset (`create --template wiki`, issue #1511) writes its migration as plain text with
// a `{{schema}}` token, before the app kit is installed. These are its two resources as the
// preset's `resources/space.ts` and `resources/page.ts` define them, and the migration must be
// exactly the tables the app kit writes to for them: `spaces`, then `pages` with `page_revisions`.
const space = defineResource({
  name: 'space',
  fields: { name: text({ max: 120 }) },
  access: { read: 'member', create: 'role:builder', update: 'role:builder', delete: 'role:admin' },
});

const page = definePages({
  space: true,
  access: { read: 'member', create: 'member', update: 'member', delete: 'role:admin' },
  agents: { read: true, write: ['title', 'blocks', 'parent', 'space'] },
});

async function wikiFiles(appName: string): Promise<ReadonlyMap<string, string>> {
  const { files } = await renderAppTemplate('wiki', { appName, version: '1.2.3' });
  return new Map(files.map((file) => [file.path, file.contents]));
}

describe("the wiki preset's migration", () => {
  it.each(['x', 'team-wiki'])(
    'renders as createTableSql(space, %j) + createTableSql(page, %j)',
    async (appName) => {
      const migration = (await wikiFiles(appName)).get('db/migrations/0003_wiki.sql');

      expect(createTableSql(page, appName)).toContain('"page_revisions"');
      expect(migration).toBe(createTableSql(space, appName) + createTableSql(page, appName));
    },
  );

  it('is the fourth and last entry of the journal, after the app kit', async () => {
    const journal = (await wikiFiles('x')).get('db/migrations/meta/_journal.json') ?? '{}';
    const entries = (JSON.parse(journal) as { entries: { idx: number; tag: string }[] }).entries;

    expect(entries.map((entry) => entry.tag)).toEqual([
      '0000_app_kit',
      '0001_app_kit_recipes',
      '0002_app_kit_channels',
      '0003_wiki',
    ]);
  });

  it('defines the resources this test mirrors', async () => {
    const files = await wikiFiles('x');
    const spaceFile = files.get('resources/space.ts') ?? '';
    const pageFile = files.get('resources/page.ts') ?? '';

    expect(spaceFile).toContain("name: 'space',");
    expect(spaceFile).toContain('name: text({ max: 120 }),');
    expect(spaceFile).toContain("create: 'role:builder',");
    expect(pageFile).toContain('space: true,');
    expect(pageFile).toContain(
      "agents: { read: true, write: ['title', 'blocks', 'parent', 'space'] },",
    );
  });
});
