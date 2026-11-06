import { DefinitionError } from '@indx-workspace/sdk/define';
import { describe, expect, it } from 'vitest';

import { defineApp } from '../app.js';
import { text } from '../fields/index.js';
import { defineResource, isDefinedResource } from '../resource.js';
import { definePages, isPageResource } from './define-pages.js';

const access = {
  read: 'member',
  create: 'member',
  update: 'member',
  delete: 'role:admin',
} as const;

function issuesOf(run: () => unknown): readonly { path: string; message: string }[] {
  try {
    run();
  } catch (error) {
    if (error instanceof DefinitionError) return error.issues;
    throw error;
  }
  throw new Error('expected a DefinitionError');
}

describe('definePages', () => {
  it('is a resource named page with the fixed fields, search and the page kind', () => {
    const pages = definePages({ access, agents: { read: true, write: ['title', 'blocks'] } });
    expect(isDefinedResource(pages)).toBe(true);
    expect(isPageResource(pages)).toBe(true);
    expect(pages).toMatchObject({ name: 'page', plural: 'pages', kind: 'page', space: false });
    expect(Object.keys(pages.fields)).toEqual(['title', 'parent', 'position', 'blocks']);
    expect(pages.fields.title.options).toMatchObject({ max: 300 });
    expect(pages.fields.parent).toMatchObject({ type: 'ref', optional: true });
    expect(pages.fields.parent.options).toMatchObject({ resource: 'page' });
    expect(pages.search).toEqual(['title', 'blocks']);
    // The store places an agent's new page, so position joins a write list.
    expect(pages.agents).toEqual({ read: true, write: ['title', 'blocks', 'position'] });
    expect(Object.isFrozen(pages)).toBe(true);
  });

  it('adds a space reference, and the app must define the space resource', () => {
    const docs = definePages({ name: 'doc', space: true, access });
    expect(Object.keys(docs.fields)).toEqual(['title', 'parent', 'position', 'blocks', 'space']);
    expect(docs.fields.parent.options).toMatchObject({ resource: 'doc' });
    expect(() => defineApp({ name: 'wiki', resources: [docs] })).toThrow(/ref\("space"\)/u);
    const spaces = defineResource({ name: 'space', fields: { title: text() }, access });
    expect(defineApp({ name: 'wiki', resources: [spaces, docs] }).resources).toHaveLength(2);
  });

  it('leaves agents without writes alone, and a plain resource is not the page kind', () => {
    expect(definePages({ access, agents: { read: true, write: false } }).agents.write).toBe(false);
    expect(
      isPageResource(defineResource({ name: 'note', fields: { title: text() }, access })),
    ).toBe(false);
    expect(isPageResource({ kind: 'page' })).toBe(false);
  });

  it('lists every reason, its own and defineResource’s, at once', () => {
    const issues = issuesOf(() =>
      definePages({
        access: { ...access, update: 'owner' },
        agents: { read: true, write: ['title', 'colour' as 'title'] },
        fields: {},
      } as unknown as Parameters<typeof definePages>[0]),
    );
    expect(issues.map((issue) => issue.path)).toEqual([
      '(root)',
      'access.update',
      'agents.write.1',
    ]);
    expect(issues[0]?.message).toMatch(/Unrecognized key: "fields"/u);
  });
});
