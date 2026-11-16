// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchDouble, jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';

import { FilesScreen } from './resource-screens';

const FILE = {
  id: 'cmVwb3J0LnBkZg',
  path: 'report.pdf',
  kind: 'file',
  sizeBytes: 5,
  contentType: 'application/pdf',
  lastModified: '2026-11-04T10:00:00.000Z',
};

const RULES_HIT = {
  path: '経費/経費規程.pdf',
  page: 3,
  snippet: '…22時以降の帰宅は深夜のタクシー利用を認める…',
  score: 0.5,
};
const SHEET_HIT = { path: 'budget.xlsx', page: 2, snippet: 'taxi 1200', score: 0.25 };
const TEXT_HIT = { path: 'notes.txt', page: null, snippet: 'taxi home', score: 0.1 };

type SearchAnswer = Response | Promise<Response>;

/** Lists `report.pdf` in every folder and answers each search with the next of `answers`. */
function server(...answers: SearchAnswer[]) {
  return fetchDouble((request: RecordedRequest) => {
    if (request.url.pathname === '/api/files/search') {
      const answer = answers.shift();
      if (answer === undefined) throw new Error('an unexpected search');
      return answer;
    }
    return jsonResponse(200, { files: [FILE] });
  });
}

const found = (hits: readonly unknown[], pending = 0) => jsonResponse(200, { hits, pending });

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  window.history.replaceState(null, '', '/files');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function render(
  double: ReturnType<typeof fetchDouble>,
  locale: 'en' | 'ja' = 'en',
): Promise<void> {
  vi.stubGlobal('fetch', double.fetch);
  act(() => root.render(<FilesScreen locale={locale} />));
  await vi.waitFor(() => expect(host.textContent).toContain('report.pdf'));
}

function searchInput(): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>('form[role="search"] input');
  if (input === null) throw new Error('no search box');
  return input;
}

function type(value: string): void {
  const input = searchInput();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(value: string): Promise<void> {
  type(value);
  act(() => searchInput().form?.requestSubmit());
  await settle();
}

function buttonNamed(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === name,
  );
  if (found === undefined) throw new Error(`no ${name} button`);
  return found;
}

const searches = (double: ReturnType<typeof fetchDouble>) =>
  double.calls
    .filter((call) => call.url.pathname === '/api/files/search')
    .map((call) => call.url.searchParams.get('q'));

const folderTableShown = () => host.querySelector('table') !== null;

describe('FilesScreen search (UX-17, #2090)', () => {
  it('shows each hit with its path, page or sheet, snippet and actions, in place of the folder', async () => {
    const double = server(found([RULES_HIT, SHEET_HIT, TEXT_HIT]));
    await render(double);

    await submit('  深夜 タクシー  ');

    expect(searches(double)).toEqual(['深夜 タクシー']);
    expect(folderTableShown()).toBe(false);
    const items = [...host.querySelectorAll('li')];
    expect(items.map((item) => item.querySelector('p')?.textContent)).toEqual([
      '経費/経費規程.pdfPage 3',
      'budget.xlsxSheet 2',
      'notes.txt',
    ]);
    expect(items[0]?.textContent).toContain('…22時以降の帰宅は深夜のタクシー利用を認める…');
    expect(items[0]?.querySelector('a')?.getAttribute('href')).toMatch(/^\/api\/files\/[\w-]+$/u);
    expect(host.textContent).toContain('Results for "深夜 タクシー"');
  });

  it('clears back to the folder listing, by button, by Escape and by emptying the box', async () => {
    const double = server(found([TEXT_HIT]), found([TEXT_HIT]), found([TEXT_HIT]));
    await render(double);

    await submit('taxi');
    act(() => buttonNamed('Clear search').click());
    expect(folderTableShown()).toBe(true);
    expect(searchInput().value).toBe('');

    await submit('taxi');
    expect(folderTableShown()).toBe(false);
    act(() => {
      searchInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(folderTableShown()).toBe(true);

    // Emptying the box, as the browser's own clear button does, leaves the search too.
    await submit('taxi');
    expect(folderTableShown()).toBe(false);
    type('');
    expect(folderTableShown()).toBe(true);
  });

  it('does not search for an empty or blank query, and shows the folder', async () => {
    const double = server();
    await render(double);

    await submit('   ');

    expect(searches(double)).toEqual([]);
    expect(folderTableShown()).toBe(true);
  });

  it('says when nothing matched', async () => {
    await render(server(found([])));

    await submit('zebracorn');

    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'No file contains "zebracorn".',
    );
  });

  it('explains partial results and searches again on request', async () => {
    const double = server(found([TEXT_HIT], 3), found([TEXT_HIT, SHEET_HIT]));
    await render(double);

    await submit('taxi');
    expect(host.textContent).toContain('results may be incomplete');

    act(() => buttonNamed('Search again').click());
    await settle();

    expect(searches(double)).toEqual(['taxi', 'taxi']);
    expect(host.textContent).not.toContain('results may be incomplete');
    expect(host.querySelectorAll('li')).toHaveLength(2);
  });

  it.each([
    [400, 'invalid_search_query', 'Type at least one word to search for.'],
    [503, 'files_runtime_not_configured', 'File search is not available on this deployment.'],
    [404, 'feature_disabled', 'Files is switched off for this workspace. Reload the page.'],
    [403, 'forbidden', 'Your role cannot search files. Ask an Owner of this workspace for access.'],
    [500, 'search_unavailable', 'The search failed. Try again.'],
  ])('says a %i %s plainly', async (status, code, text) => {
    await render(server(jsonResponse(status, { error: { code, message: 'raw server text' } })));

    await submit('&|!');

    expect(host.querySelector('[role="alert"]')?.textContent).toBe(text);
    expect(folderTableShown()).toBe(false);
  });

  it('shows the loading state, and an earlier answer never replaces a later one', async () => {
    let answerFirst: (response: Response) => void = () => undefined;
    const slow = new Promise<Response>((resolve) => {
      answerFirst = resolve;
    });
    await render(server(slow, found([SHEET_HIT])));

    await submit('first');
    expect(host.textContent).toContain('Searching…');
    expect(
      host.querySelector<HTMLButtonElement>('form[role="search"] button[type="submit"]')?.disabled,
    ).toBe(true);

    await submit('second');
    answerFirst(found([TEXT_HIT]));
    await settle();

    expect(host.textContent).toContain('Results for "second"');
    expect(host.textContent).toContain('budget.xlsx');
    expect(host.textContent).not.toContain('notes.txt');
  });

  it('a search cleared while in flight stays cleared', async () => {
    let answer: (response: Response) => void = () => undefined;
    await render(
      server(
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
      ),
    );

    await submit('taxi');
    act(() => buttonNamed('Clear search').click());
    answer(found([TEXT_HIT]));
    await settle();

    expect(folderTableShown()).toBe(true);
    expect(host.textContent).not.toContain('notes.txt');
  });

  it("opens a hit's folder and leaves the search", async () => {
    const double = server(found([RULES_HIT]));
    await render(double);

    await submit('タクシー');
    act(() => buttonNamed('Open folder').click());
    await settle();

    expect(window.location.search).toBe(`?path=${encodeURIComponent('経費')}`);
    expect(double.calls.at(-1)?.url.searchParams.get('path')).toBe('経費');
    expect(folderTableShown()).toBe(true);
    expect(searchInput().value).toBe('');
  });

  it('speaks Japanese when the console is negotiated to it', async () => {
    await render(server(found([SHEET_HIT], 1)), 'ja');

    await submit('タクシー');

    expect(host.textContent).toContain('ファイルの中身を検索');
    expect(host.textContent).toContain('「タクシー」の検索結果');
    expect(host.textContent).toContain('シート 2');
    expect(host.textContent).toContain('もう一度検索');
    expect(host.textContent).toContain('フォルダーを開く');
    // <html> stays en for the English parts of Files, so the search says its own language.
    expect(searchInput().closest('[lang]')?.getAttribute('lang')).toBe('ja');
  });
});

describe('FilesScreen modified time (UX-15)', () => {
  it('prints the listing in the screen language', async () => {
    await render(server(), 'ja');
    expect(host.textContent).toContain('2026年11月4日');
  });

  it('prints English for an English screen', async () => {
    await render(server(), 'en');
    expect(host.textContent).toContain('Nov 4, 2026');
  });
});
