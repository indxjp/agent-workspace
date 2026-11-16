import { fetchDouble, jsonResponse } from '@indx-workspace/sdk/testing';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { PageRevision } from '../db/page-port.js';
import { definePages } from '../pages/define-pages.js';
import { ResourceProblemError } from './client.js';
import { appStrings } from './locale.js';
import { pageClient, type PageClient } from './page-client.js';
import { PageConflictNotice, PageRevisionList, PageView } from './page-view.js';

const pages = definePages({
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
  agents: { read: true, write: ['title', 'blocks'] },
});

const WORKSPACE = '00000000-0000-4000-8000-0000000000aa';
const PAGE = '0f5c2a8e-1b2c-4d3e-8f90-123456789abc';
const PERSON = '33333333-3333-4333-8333-333333333333';
const RUN = '77777777-7777-4777-8777-777777777777';
const strings = appStrings('en').pages;
const noop = (): void => undefined;

function revision(id: string, overrides: Partial<PageRevision> = {}): PageRevision {
  return {
    id,
    workspace_id: WORKSPACE,
    page_id: PAGE,
    title: 'Printers',
    blocks: [{ type: 'paragraph', text: 'Clear the <tray>.' }],
    author_principal_id: PERSON,
    run_id: null,
    at: '2026-11-01T09:00:00.000Z',
    ...overrides,
  };
}

const revisions = [
  revision('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', {
    run_id: RUN,
    blocks: [{ type: 'heading1', text: 'Printers, rewritten' }],
    at: '2026-11-01T09:05:00.000Z',
  }),
  revision('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
];

function list(
  overrides: { readonly platformUrl?: string; readonly names?: Map<string, string> } = {},
): string {
  return renderToStaticMarkup(
    <PageRevisionList
      revisions={revisions}
      currentRevisionId={revisions[0]?.id ?? null}
      strings={strings}
      locale="en"
      platformUrl={overrides.platformUrl}
      agentNames={overrides.names ?? new Map()}
      personName={() => 'Desk person'}
      pending={false}
      onRestore={noop}
    />,
  );
}

describe('PageRevisionList (#1521)', () => {
  it('badges an agent’s revision, names its agent, and links its run', () => {
    const html = list({ platformUrl: 'https://aw.test', names: new Map([[RUN, 'Writer']]) });
    expect(html).toContain(
      '<span class="aw-app-badge" data-tone="info">Agent</span> Saved by Writer',
    );
    expect(html).toContain(
      `<a href="https://aw.test/runs?run=${RUN}" aria-label="Open run ${RUN}">77777777</a>`,
    );
    expect(html).toContain('Saved by Desk person');
    expect(html.match(/data-tone="info"/gu)).toHaveLength(1);
  });

  it('marks the current revision, and offers Restore on the others, named by time', () => {
    const html = list();
    expect(html).toContain('<span class="aw-app-badge">Current</span>');
    expect(html.match(/>Restore<\/button>/gu)).toHaveLength(1);
    expect(html).toMatch(/aria-label="Restore the revision of [^"]*9:00:00[^"]*"/u);
    expect(html).toContain('<time dateTime="2026-11-01T09:05:00.000Z">');
  });

  it('previews each revision through AssistantProse, its text never raw HTML', () => {
    const html = list();
    expect(html).toContain('<summary>Preview</summary>');
    expect(html).toContain('<h1>Printers, rewritten</h1>');
    expect(html).toContain('<p>Clear the .</p>');
    expect(html).not.toContain('<tray>');
  });

  it('names an agent it did not start as an agent, and its run without a link', () => {
    const html = list();
    expect(html).toContain('Saved by An agent <code>77777777</code>');
    expect(html).not.toContain('<a ');
  });

  it('says when there is no revision', () => {
    expect(
      renderToStaticMarkup(
        <PageRevisionList
          revisions={[]}
          currentRevisionId={null}
          strings={strings}
          locale="en"
          agentNames={new Map()}
          personName={() => 'x'}
          pending={false}
          onRestore={noop}
        />,
      ),
    ).toContain('No revision yet.');
  });
});

describe('PageConflictNotice (#1521)', () => {
  it('offers Load latest and Keep mine on a refused save, and never merges', () => {
    const html = renderToStaticMarkup(
      <PageConflictNotice
        reason="conflict"
        strings={strings}
        pending={false}
        onLoadLatest={noop}
        onKeepMine={noop}
      />,
    );
    expect(html).toContain('<div class="aw-app-alert" role="alert">');
    expect(html).toContain('This page changed since you opened it.');
    expect(html).toContain('>Load latest</button>');
    expect(html).toContain('>Keep mine</button>');
  });

  it('says when an agent changed the page under unsaved edits, in Japanese too', () => {
    const html = renderToStaticMarkup(
      <PageConflictNotice
        reason="agent"
        strings={appStrings('ja').pages}
        pending
        onLoadLatest={noop}
        onKeepMine={noop}
      />,
    );
    expect(html).toContain('編集中にエージェントがこのページを変更しました。');
    expect(html).toContain('disabled="">最新版を読み込む</button>');
  });
});

describe('PageView (#1521)', () => {
  it('says it is loading until the page is read', () => {
    const pending = new Proxy({} as PageClient<typeof pages.fields>, {
      get: () => () => new Promise(() => undefined),
    });
    const html = renderToStaticMarkup(
      <PageView resource={pages} id={PAGE} client={pending} locale="ja" />,
    );
    expect(html).toBe('<p class="aw-app-status" role="status">読み込み中…</p>');
  });
});

describe('pageClient (#1521)', () => {
  const record = {
    id: PAGE,
    workspace_id: WORKSPACE,
    created_at: '2026-11-01T09:00:00.000Z',
    updated_at: '2026-11-01T09:00:00.000Z',
    created_by: PERSON,
    updated_by: PERSON,
    title: 'Printers',
    parent: null,
    position: 0,
    blocks: [],
    revision_id: revisions[1]?.id,
  };

  it('reaches the page routes, and parses a page with its revision_id', async () => {
    const platform = fetchDouble((request) => {
      const path = `${request.method} ${request.url.pathname}${request.url.search}`;
      if (path === `GET /api/pages/children?parent=${PAGE}`) {
        return jsonResponse(200, { items: [record] });
      }
      if (path === `GET /api/pages/${PAGE}/revisions?limit=1`) {
        return jsonResponse(200, { items: [revisions[0]], nextCursor: 'next' });
      }
      if (path === `POST /api/pages/${PAGE}/restore`) return jsonResponse(200, record);
      if (path === `POST /api/pages/${PAGE}/move`) return jsonResponse(200, record);
      if (path === `PATCH /api/pages/${PAGE}`) {
        return jsonResponse(409, { error: { code: 'page_conflict', message: 'Stale.' } });
      }
      return jsonResponse(200, { ...record, revision_id: 'not-a-uuid' });
    });
    const client = pageClient(pages, { fetch: platform.fetch, baseUrl: 'https://app.test/' });
    expect((await client.children(PAGE))[0]?.revision_id).toBe(record.revision_id);
    expect(await client.revisions(PAGE, { limit: 1 })).toEqual({
      items: [revisions[0]],
      nextCursor: 'next',
    });
    await client.restore(PAGE, 'r1', { expectedRevisionId: 'r2' });
    await client.move(PAGE, { parent: null, position: 3 });
    await expect(
      client.update(PAGE, { title: 'x', expectedRevisionId: 'r2' }),
    ).rejects.toMatchObject({ code: 'page_conflict', status: 409 });
    await expect(client.get(PAGE)).rejects.toBeInstanceOf(ResourceProblemError);
    await expect(client.get(PAGE)).rejects.toMatchObject({ code: 'contract_violation' });
    const bodies = platform.calls.filter((call) => call.method === 'POST').map((call) => call.json);
    expect(bodies).toEqual([
      { revisionId: 'r1', expectedRevisionId: 'r2' },
      { parent: null, position: 3 },
    ]);
  });
});
