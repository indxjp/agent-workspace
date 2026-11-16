import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RunDetailBody, RunDetailPanel, type RunDetailPanelCatalogs } from './run-detail-panel';
import type { CatalogState, RunListItem } from './history';
import {
  MOCKUP_TEAM_CHILDREN,
  MOCKUP_TEAM_LEAD,
  MOCKUP_TEAM_LEAD_ID,
  MOCKUP_TEAM_RESEARCHER_ID,
  MOCKUP_TEAM_TREE_COST,
  MOCKUP_TEAM_WRITER_ID,
} from './mockup-fixture';
import { EMPTY_RUN_TREE, type RunTree } from './run-tree-model';

const LOADING: CatalogState = { kind: 'loading' };
const [RESEARCHER, WRITER] = MOCKUP_TEAM_CHILDREN;
const AGENTS: CatalogState = {
  kind: 'ready',
  catalog: {
    byId: new Map([
      [MOCKUP_TEAM_LEAD.agentId, 'lead'],
      [RESEARCHER?.agentId ?? '', 'researcher'],
      [WRITER?.agentId ?? '', 'writer'],
    ]),
  },
};
const CATALOGS: RunDetailPanelCatalogs = {
  agents: AGENTS,
  projects: LOADING,
  users: LOADING,
  workspaces: LOADING,
};
const TREE: RunTree = { children: MOCKUP_TEAM_CHILDREN, treeCost: MOCKUP_TEAM_TREE_COST };

/** `href` as React writes it into markup. */
const linkTo = (runId: string) => `href="/runs?run=${runId}"`;

describe('RunDetailPanel', () => {
  it('renders the back link and a loading state, before any fetch resolves', () => {
    // `renderToStaticMarkup` never runs effects, so `GET /api/runs/:id` has not been called yet —
    // the same first-paint property `projects-screen.test.tsx` exercises.
    const html = renderToStaticMarkup(
      <RunDetailPanel
        runId="a1111111-1111-4111-8111-111111111111"
        backHref="/runs"
        catalogs={{ agents: LOADING, projects: LOADING, users: LOADING, workspaces: LOADING }}
      />,
    );
    expect(html).toContain('Back to Runs');
    expect(html).toContain('Loading run');
  });

  it('keeps every detail definition list stackable instead of fixing a mobile-width label column', async () => {
    const { readFile } = await import('node:fs/promises');
    const [detailSource, liveSource] = await Promise.all([
      readFile(new URL('./run-detail-panel.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./run-view.tsx', import.meta.url), 'utf8'),
    ]);
    expect(`${detailSource}\n${liveSource}`).not.toMatch(/grid-cols-\[\d+px_1fr\]/u);
    expect(detailSource.match(/className=\{DETAIL_KV\}/gu)).toHaveLength(4);
    expect(detailSource).toContain('sm:grid-cols-[140px_minmax(0,1fr)]');
    expect(liveSource).toContain('sm:grid-cols-[150px_minmax(0,1fr)]');
    expect(liveSource).toContain('sm:grid-cols-[105px_minmax(0,1fr)]');
    expect(detailSource).toContain('[overflow-wrap:anywhere]');
    expect(liveSource).toContain('[overflow-wrap:anywhere]');
  });
});

describe('RunDetailBody — the run tree (ADR-0104, #1517)', () => {
  it('renders the Team card with two children, their status badges, costs and links, and the tree cost', () => {
    const html = renderToStaticMarkup(
      <RunDetailBody run={MOCKUP_TEAM_LEAD} tree={TREE} catalogs={CATALOGS} locale="en" />,
    );
    expect(html).toContain('data-testid="run-team"');
    // UX-05: the run's conversation opens on the home chat; the raw session data stays linked.
    expect(html).toContain(
      'href="/?session=d1111111-1111-4111-8111-111111111111">Open conversation</a>',
    );
    expect(html).toContain(
      'href="/api/sessions/d1111111-1111-4111-8111-111111111111">raw session data</a>',
    );
    expect(html).not.toContain('ADR');
    expect(html).toContain('>Team</h2>');
    expect(html.match(/<details/gu)).toHaveLength(2);
    expect(html.match(/<summary/gu)).toHaveLength(2);
    expect(html).toContain('researcher');
    expect(html).toContain('writer');
    expect(html).toContain('Completed');
    expect(html).toContain('Running');
    expect(html).toContain('$0.02 · Actual');
    expect(html).toContain('Pending');
    expect(html).toContain(linkTo(MOCKUP_TEAM_RESEARCHER_ID));
    expect(html).toContain(linkTo(MOCKUP_TEAM_WRITER_ID));
    expect(html).toContain('aria-label="Opens child run: researcher"');
    // The tree cost sits beside the run's own cost, and says a child is not priced yet.
    expect(html).toContain('$0.05 · Actual');
    expect(html).toMatch(/Tree cost: <b[^>]*>\$0\.07<\/b>/u);
    expect(html).toContain('Includes runs that are not priced yet');
    // The researcher precedes the writer: oldest first.
    expect(html.indexOf(linkTo(MOCKUP_TEAM_RESEARCHER_ID))).toBeLessThan(
      html.indexOf(linkTo(MOCKUP_TEAM_WRITER_ID)),
    );
  });

  it('renders no Team card and no tree cost for a run without children', () => {
    const html = renderToStaticMarkup(
      <RunDetailBody
        run={MOCKUP_TEAM_LEAD}
        tree={EMPTY_RUN_TREE}
        catalogs={CATALOGS}
        locale="en"
      />,
    );
    expect(html).not.toContain('data-testid="run-team"');
    expect(html).not.toContain('data-testid="run-tree-cost"');
    expect(html).not.toContain('data-testid="run-parent"');
  });

  it('links a child run to its lead run', () => {
    const html = renderToStaticMarkup(
      <RunDetailBody
        run={RESEARCHER ?? MOCKUP_TEAM_LEAD}
        tree={EMPTY_RUN_TREE}
        catalogs={CATALOGS}
        locale="en"
      />,
    );
    expect(html).toContain('data-testid="run-parent"');
    expect(html).toContain('Part of a team run');
    expect(html).toContain(linkTo(MOCKUP_TEAM_LEAD_ID));
  });

  it('renders the Japanese strings for the ja locale', () => {
    const html = renderToStaticMarkup(
      <RunDetailBody run={MOCKUP_TEAM_LEAD} tree={TREE} catalogs={CATALOGS} locale="ja" />,
    );
    expect(html).toContain('>チーム</h2>');
    expect(html).toContain('ツリー全体のコスト');
    expect(html).toContain('子ランを開く');
    expect(html).not.toContain('>Team</h2>');
  });
});

describe('RunDetailBody — the spend ceiling (ADR-0162)', () => {
  const STOPPED: RunListItem = {
    ...MOCKUP_TEAM_LEAD,
    status: 'failed',
    output: null,
    spendCeilingUsd: '0.500000',
    error: 'run_budget_reached: The run stopped at its spend ceiling of 9 USD.',
  };
  const body = (run: RunListItem, locale: 'en' | 'ja' = 'en') =>
    renderToStaticMarkup(
      <RunDetailBody run={run} tree={EMPTY_RUN_TREE} catalogs={CATALOGS} locale={locale} />,
    );

  it('says the run stopped at its spend ceiling, naming the ceiling from the run, not the message', () => {
    const html = body(STOPPED);
    expect(html).toContain('data-testid="run-spend-ceiling-notice"');
    expect(html).toContain('role="status"');
    expect(html).toContain('Stopped at its spend ceiling (0.5 USD)');
    expect(html).not.toContain('9 USD');
  });

  it('shows the ceiling next to the cost', () => {
    const html = body(STOPPED);
    expect(html).toContain('data-testid="run-spend-ceiling"');
    expect(html).toMatch(/Spend ceiling:\s*<b class="font-semibold">0\.5 USD<\/b>/u);
  });

  it('says a ceiling could not be enforced on an unpriced run', () => {
    const html = body({
      ...MOCKUP_TEAM_LEAD,
      spendCeilingUsd: '1.000000',
      accountingState: 'unavailable',
      cost: { amount: '0.000000', currency: 'USD', priceTableVersion: null },
    });
    expect(html).toContain(
      'This run&#x27;s model has no price, so its spend ceiling could not be enforced.',
    );
  });

  it('shows nothing about a ceiling for a run without one', () => {
    const html = body(MOCKUP_TEAM_LEAD);
    expect(html).not.toContain('data-testid="run-spend-ceiling"');
    expect(html).not.toContain('data-testid="run-spend-ceiling-notice"');
  });

  it('renders the Japanese strings for the ja locale', () => {
    const html = body(STOPPED, 'ja');
    expect(html).toContain('利用上限（0.5 USD）に達したため停止しました');
    expect(html).toContain('利用上限');
  });
});
