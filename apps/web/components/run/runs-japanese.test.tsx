// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNTING_STATE_NAMES,
  formatCostDisplay,
  formatDuration,
  formatProviderModel,
  type CatalogState,
  type RunListItem,
} from './history';
import { MOCKUP_TEAM_CHILDREN, MOCKUP_TEAM_LEAD, MOCKUP_TEAM_TREE_COST } from './mockup-fixture';
import { accountingStateText, runsStrings } from './runs-messages';

// UX-15 in #2086: the Runs list and the run detail panel in the reader's language.

let searchParams = new URLSearchParams('');
vi.mock('next/navigation', () => ({
  usePathname: () => '/runs',
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
const requests = vi.hoisted(() => ({
  page: vi.fn(),
  catalog: vi.fn(),
  probe: vi.fn(),
  detail: vi.fn(),
}));
vi.mock('./run-requests-model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./run-requests-model')>()),
  loadRunPage: requests.page,
  loadCatalog: requests.catalog,
  probeUserFilter: requests.probe,
  loadRunDetail: requests.detail,
}));
vi.mock('../../lib/browser-client', () => ({ browserClient: () => ({}) }));

const { RunsHistoryScreen } = await import('./history-screen');
const { RunDetailBody, RunDetailPanel } = await import('./run-detail-panel');

const en = runsStrings('en');
const ja = runsStrings('ja');

/** Every word a strings object holds, keyed by its path; functions are called with samples. */
function flatten(value: unknown, path = '', out = new Map<string, string>()): Map<string, string> {
  if (typeof value === 'string') out.set(path, value);
  else if (typeof value === 'function') {
    out.set(path, (value as (...args: unknown[]) => string)('3', '2', '1'));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) flatten(inner, `${path}.${key}`, out);
  }
  return out;
}

/** English shows an accounting state by its own name, so it has no words of its own to compare. */
function withoutStates(strings: typeof en): Record<string, unknown> {
  return Object.fromEntries(Object.entries(strings).filter(([key]) => key !== 'accountingStates'));
}

/** Every English word these screens print; a Japanese screen shows none as a text node or label. */
const ENGLISH = [...flatten(withoutStates(en)).values()]
  .map((word) => word.trim())
  .filter((word) => word.length > 1);

function readable(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/>([^<]+)</gu)) out.push((match[1] ?? '').trim());
  for (const match of html.matchAll(/(?:aria-label|placeholder)="([^"]*)"/gu)) {
    out.push(match[1] ?? '');
  }
  return out.filter((text) => text !== '');
}

function expectJapanese(html: string, ...expected: string[]): void {
  for (const text of expected) expect(html).toContain(text);
  const seen = readable(html);
  for (const english of ENGLISH) expect(seen, english).not.toContain(english);
  // The status badge's English words, too: a Japanese screen never mixes them in.
  for (const badge of ['Queued', 'Running', 'Completed', 'Failed', 'Cancelled', 'Unknown']) {
    expect(seen, badge).not.toContain(badge);
  }
}

describe('the Runs words', () => {
  it('has a Japanese word for every English one, and never the same word', () => {
    const english = flatten(withoutStates(en));
    const japanese = flatten(withoutStates(ja));
    expect([...japanese.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, word] of english) {
      expect(japanese.get(key), key).not.toBe('');
      expect(japanese.get(key), key).not.toBe(word);
    }
  });

  it('names every accounting state in Japanese; English keeps its own name', () => {
    for (const state of ACCOUNTING_STATE_NAMES) {
      expect(accountingStateText(state, en)).toBe(state);
      expect(accountingStateText(state, ja)).not.toBe(state);
    }
    // A state this build does not know, or an inherited name, is shown as it came.
    expect(accountingStateText('settling', ja)).toBe('settling');
    expect(accountingStateText('constructor', ja)).toBe('constructor');
  });

  it('builds a run’s figures in Japanese, and in English exactly as before', () => {
    expect(formatDuration(65_000, 'completed')).toBe('1 m 05 s');
    expect(formatDuration(65_000, 'completed', ja)).toBe('1 分 05 秒');
    expect(formatDuration(3_725_000, 'completed', ja)).toBe('1 時間 02 分 05 秒');
    expect(formatDuration(12_000, 'completed', ja)).toBe('12 秒');
    expect(formatDuration(450, 'completed', ja)).toBe('450 ミリ秒');
    expect(formatDuration(null, 'queued', ja)).toBe('未開始');
    expect(formatDuration(null, 'running', ja)).toBe('実行中');
    expect(formatDuration(null, 'failed', ja)).toBe('所要時間は不明');
    expect(formatProviderModel(null, null, ja)).toBe('まだ決まっていません');
    expect(formatProviderModel(null, null)).toBe('Not yet resolved');
    const settled: RunListItem = {
      ...MOCKUP_TEAM_LEAD,
      accountingState: 'partial',
      cost: { amount: '0.120000', currency: 'USD', priceTableVersion: 'v1' },
    };
    expect(formatCostDisplay(settled)).toBe('$0.12 · Actual · Partial');
    expect(formatCostDisplay(settled, ja)).toBe('$0.12 · 実績 · 一部のみ');
    expect(
      formatCostDisplay(
        { ...MOCKUP_TEAM_LEAD, accountingState: 'failed', accountingError: 'no price' },
        ja,
      ),
    ).toBe('集計に失敗しました — no price');
  });
});

const READY = (entries: readonly (readonly [string, string])[]): CatalogState => ({
  kind: 'ready',
  catalog: { byId: new Map(entries) },
});

describe('the run detail for a Japanese reader', () => {
  const [researcher, writer] = MOCKUP_TEAM_CHILDREN;
  const catalogs = {
    agents: READY([
      [MOCKUP_TEAM_LEAD.agentId, 'lead'],
      [researcher?.agentId ?? '', 'researcher'],
      [writer?.agentId ?? '', 'writer'],
    ]),
    projects: { kind: 'loading' } as const,
    users: { kind: 'loading' } as const,
    workspaces: { kind: 'loading' } as const,
  };

  it('every label, the badges, the team card and the server’s error marked English', () => {
    const run: RunListItem = {
      ...MOCKUP_TEAM_LEAD,
      status: 'failed',
      error: 'runtime exited with code 1',
      accountingState: 'failed',
      accountingError: 'price table missing',
    };
    const html = renderToStaticMarkup(
      <RunDetailBody
        run={run}
        tree={{ children: MOCKUP_TEAM_CHILDREN, treeCost: MOCKUP_TEAM_TREE_COST }}
        catalogs={catalogs}
        locale="ja"
      />,
    );
    expectJapanese(
      html,
      '>技術的な詳細</h2>',
      '>使用量</h3>',
      '>ランタイム</h3>',
      '>集計の状態</dt><dd>失敗</dd>',
      '>状態</dt><dd>失敗</dd>',
      '会話を開く',
      'セッションの生データ',
      '<dd lang="en" class="text-danger">runtime exited with code 1</dd>',
      '<dd lang="en" class="text-danger">price table missing</dd>',
      'lang="ja"',
    );
  });

  it('an English reader sees the detail exactly as before', () => {
    const html = renderToStaticMarkup(
      <RunDetailBody
        run={MOCKUP_TEAM_LEAD}
        tree={{ children: [], treeCost: null }}
        catalogs={catalogs}
        locale="en"
      />,
    );
    for (const text of [
      '>Technical details</h2>',
      `>Status</dt><dd>${MOCKUP_TEAM_LEAD.status}</dd>`,
      `>Accounting state</dt><dd>${MOCKUP_TEAM_LEAD.accountingState}</dd>`,
      '>Open conversation</a>',
    ]) {
      expect(html).toContain(text);
    }
  });
});

describe('the Runs list for a Japanese reader', () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    requests.catalog.mockImplementation((_client: unknown, kind: string) =>
      Promise.resolve(
        kind === 'agents'
          ? { byId: new Map([[MOCKUP_TEAM_LEAD.agentId, 'lead']]) }
          : { byId: new Map() },
      ),
    );
    requests.probe.mockResolvedValue('available');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  async function show(locale: 'en' | 'ja'): Promise<string> {
    await act(async () => {
      createRoot(container).render(<RunsHistoryScreen locale={locale} />);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    return container.innerHTML;
  }

  it('the heading, every filter, the table and its rows', async () => {
    searchParams = new URLSearchParams('status=failed');
    requests.page.mockResolvedValue({
      ok: true,
      value: { runs: [MOCKUP_TEAM_LEAD, ...MOCKUP_TEAM_CHILDREN], nextCursor: 'next' },
    });
    const html = await show('ja');
    expectJapanese(
      html,
      '>実行</h1>',
      'このページを検索',
      'placeholder="実行、モデル、名前"',
      '>すべての状態</option>',
      '>失敗</option>',
      '>開始した人</span>',
      '>全員</option>',
      '>絞り込みを解除</button>',
      '>開始日時</th>',
      '>コスト</th>',
      'aria-label="実行 ',
      '>開く</a>',
      '>次のページ →</a>',
    );
    expect(html).toContain('<main lang="ja"');
  });

  it('a page that answers with a problem keeps the server’s sentence marked English', async () => {
    searchParams = new URLSearchParams('');
    requests.page.mockResolvedValue({
      ok: false,
      problem: { kind: 'api', status: 403, code: 'forbidden', message: 'Not allowed.' },
    });
    const html = await show('ja');
    expect(html).toContain(
      '<div class="font-semibold">実行の一覧を読み込めませんでした。</div><b class="font-semibold">403 forbidden</b><div lang="en">Not allowed.</div>',
    );
  });

  it('an English reader sees a refused page as before, with no lead', async () => {
    searchParams = new URLSearchParams('');
    requests.page.mockResolvedValue({
      ok: false,
      problem: { kind: 'transport', reason: 'The run list could not be loaded: offline' },
    });
    const html = await show('en');
    expect(html).toContain(
      '<div class="min-w-0 flex-1"><div lang="en">The run list could not be loaded: offline</div></div>',
    );
  });

  it('nothing matches, in Japanese', async () => {
    searchParams = new URLSearchParams('');
    requests.page.mockResolvedValue({ ok: true, value: { runs: [], nextCursor: null } });
    expectJapanese(await show('ja'), ja.noRuns);
  });

  it('an English reader sees the list exactly as before', async () => {
    searchParams = new URLSearchParams('status=failed');
    requests.page.mockResolvedValue({
      ok: true,
      value: { runs: [MOCKUP_TEAM_LEAD], nextCursor: null },
    });
    const html = await show('en');
    for (const text of [
      '>Runs</h1>',
      '>failed</option>',
      '>Started by</span>',
      '>Provider / model</th>',
      `aria-label="Open run ${MOCKUP_TEAM_LEAD.id}"`,
    ]) {
      expect(html).toContain(text);
    }
  });
});

describe('a run that cannot be loaded', () => {
  const catalogs = {
    agents: { kind: 'loading' } as const,
    projects: { kind: 'loading' } as const,
    users: { kind: 'loading' } as const,
    workspaces: { kind: 'loading' } as const,
  };
  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  async function show(locale: 'en' | 'ja'): Promise<string> {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    requests.detail.mockResolvedValue({
      kind: 'problem',
      problem: { kind: 'transport', reason: 'The run could not be loaded: offline' },
    });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <RunDetailPanel
          runId={MOCKUP_TEAM_LEAD.id}
          backHref="/runs"
          catalogs={catalogs}
          locale={locale}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const html = container.innerHTML;
    act(() => root.unmount());
    vi.unstubAllGlobals();
    return html;
  }

  it('leads in Japanese and keeps the transport sentence English', async () => {
    expect(await show('ja')).toContain(
      '<div class="font-semibold">この実行を読み込めませんでした。</div><div lang="en">The run could not be loaded: offline</div>',
    );
  });

  it('prints it in English as before, with no lead', async () => {
    const html = await show('en');
    expect(html).toContain(
      '<div class="min-w-0 flex-1"><div lang="en">The run could not be loaded: offline</div></div>',
    );
  });
});
