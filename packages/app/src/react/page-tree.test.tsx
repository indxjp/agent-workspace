import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { definePages } from '../pages/define-pages.js';
import { appStrings } from './locale.js';
import type { PageClient } from './page-client.js';
import { PageMoveForm, PageTree, PageTreeView } from './page-tree.js';
import { visibleRows, type PageTreeLevels, type PageTreeNode } from './page-tree-model.js';

const pages = definePages({
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
});

const node = (id: string, title: string, parent: string | null = null): PageTreeNode => ({
  id,
  title,
  parent,
});

const levels: PageTreeLevels = new Map<string | null, readonly PageTreeNode[]>([
  [null, [node('a', 'Handbook'), node('b', '<Policies>')]],
  ['a', [node('a1', 'Printers', 'a'), node('a2', '', 'a')]],
  ['a1', []],
]);

const strings = appStrings('en').pages;
const noop = (): void => undefined;

/** A client whose answers never come: the server render draws the state before the first one. */
const pending = new Proxy({} as PageClient, {
  get: () => () => new Promise(() => undefined),
});

describe('PageTreeView (#1521)', () => {
  const html = renderToStaticMarkup(
    <PageTreeView
      rows={visibleRows(levels, new Set(['a']))}
      label="Pages"
      selectedId="a1"
      focusedId="a2"
      strings={strings}
    />,
  );

  it('is an ARIA tree of treeitems with levels, places and open states', () => {
    expect(html).toContain('<ul role="tree" aria-label="Pages"');
    expect(html.match(/role="treeitem"/gu)).toHaveLength(4);
    expect(html).toMatch(
      /<li role="treeitem"[^>]*aria-level="1" aria-setsize="2" aria-posinset="1" aria-expanded="true" aria-selected="false" tabindex="-1"/u,
    );
    // A leaf has no aria-expanded; a page not loaded yet reads as closed.
    expect(html).toMatch(/aria-level="2" aria-setsize="2" aria-posinset="1" aria-selected="true"/u);
    expect(html).toMatch(
      /aria-level="1" aria-setsize="2" aria-posinset="2" aria-expanded="false"/u,
    );
  });

  it('has one tab stop, on the focused row, and draws titles as text', () => {
    expect(html.match(/tabindex="0"/gu)).toHaveLength(1);
    expect(html).toMatch(
      /aria-posinset="2" aria-expanded="false" aria-selected="false" tabindex="0"/u,
    );
    expect(html).toContain('&lt;Policies&gt;');
    expect(html).toContain('>Untitled</span>');
  });

  it('says when there are no pages', () => {
    expect(
      renderToStaticMarkup(
        <PageTreeView
          rows={[]}
          label="Pages"
          selectedId={null}
          focusedId={null}
          strings={strings}
        />,
      ),
    ).toContain('No pages yet.');
  });
});

describe('PageMoveForm (#1521)', () => {
  it('offers the top and the pages outside the moving one, each control labelled', () => {
    const html = renderToStaticMarkup(
      <PageMoveForm
        id="a"
        title="Handbook"
        levels={levels}
        target=""
        problem={strings.moveIntoItself}
        pending={false}
        strings={strings}
        cancel="Cancel"
        onTarget={noop}
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain('>Move Handbook</h2>');
    expect(html).toMatch(
      /<label for="([^"]+)-target" class="aw-app-label">Move under<\/label><select id="\1-target"/u,
    );
    expect(html).toContain('<option value="" selected="">The top level</option>');
    expect(html).toContain('<option value="b">— &lt;Policies&gt;</option>');
    expect(html).not.toContain('Printers');
    expect(html).toContain('role="alert"');
  });
});

describe('PageTree (#1521)', () => {
  it('draws its actions in a labelled navigation, in Japanese too', () => {
    const html = renderToStaticMarkup(
      <PageTree pages={pages} selectedId={null} onSelect={noop} client={pending} locale="ja" />,
    );
    expect(html).toContain('<nav class="aw-app-page-tree-nav" aria-label="ページ">');
    expect(html).toContain('>新しいページ</button>');
    expect(html).toMatch(
      /<button type="button" class="aw-app-button" disabled="">移動…<\/button>/u,
    );
    expect(html).toContain('<dialog class="aw-app-dialog">');
  });
});
