import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DashboardSnapshot, RunSummary } from '../dashboard-wire.js';
import { Dashboard, DashboardView } from './dashboard.js';

const AS_OF = '2026-11-01T12:00:00.000Z';
const PLATFORM = 'https://aw.test';
const LEAD = '00000000-0000-4000-8000-0000000000a1';

function summary(id: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id,
    agentId: '11111111-1111-4111-8111-111111111111',
    status: 'running',
    createdAt: '2026-11-01T11:55:00.000Z',
    durationMs: null,
    error: null,
    pendingApproval: null,
    cost: { amount: '0.000000', currency: 'USD' },
    parentRunId: null,
    ...overrides,
  };
}

const empty: DashboardSnapshot = {
  running: [],
  waiting: [],
  failed: [],
  spendToday: [],
  asOf: AS_OF,
  truncated: { running: false, waiting: false, failed: false, spend: false },
};

const full: DashboardSnapshot = {
  ...empty,
  running: [
    summary('00000000-0000-4000-8000-000000000001', { status: 'queued' }),
    summary('00000000-0000-4000-8000-000000000002', { parentRunId: LEAD }),
  ],
  waiting: [
    summary('00000000-0000-4000-8000-000000000003', {
      status: 'awaiting_approval',
      pendingApproval: { toolName: 'ticket_update', canonicalCall: '{}' },
    }),
  ],
  failed: [
    summary('00000000-0000-4000-8000-000000000004', {
      status: 'failed',
      error: 'The model connection refused the call.',
    }),
  ],
  spendToday: [{ currency: 'USD', amount: '0.300000', runs: 4, unsettled: 1 }],
  truncated: { ...empty.truncated, failed: true },
};

function draw(snapshot: DashboardSnapshot | null, locale: 'en' | 'ja' = 'en'): string {
  return renderToStaticMarkup(
    <DashboardView
      platformUrl={PLATFORM}
      snapshot={snapshot}
      locale={locale}
      problem={null}
      agentNames={{ '11111111-1111-4111-8111-111111111111': 'Triage' }}
    />,
  );
}

function headingsOf(html: string): string[] {
  return [...html.matchAll(/<h2 id="[^"]+">([^<]+)<\/h2>/gu)].map((match) => match[1] ?? '');
}

describe('Dashboard', () => {
  it('draws four sections, each with an h2 and a table', () => {
    const html = draw(full);
    expect(headingsOf(html)).toEqual([
      'Running now',
      'Waiting for a decision',
      'Failed in the last 24 hours',
      'Spend today',
    ]);
    expect(html.match(/<section /gu)).toHaveLength(4);
    expect(html.match(/<table /gu)).toHaveLength(4);
    for (const id of ['running', 'waiting', 'failed', 'spend']) {
      expect(html).toContain(`aria-labelledby="aw-dashboard-${id}"`);
    }
  });

  it('names every row link "Open run <id>" and points it at the run view', () => {
    const html = draw(full);
    const links = [...html.matchAll(/<a href="([^"]+)" aria-label="([^"]+)">/gu)];
    expect(links).toHaveLength(4);
    for (const [, href, name] of links) {
      const id = /run=(.+)$/u.exec(href ?? '')?.[1] ?? '';
      expect(href).toBe(`${PLATFORM}/runs?run=${id}`);
      expect(name).toBe(`Open run ${id}`);
    }
  });

  it('shows what each list is about: status, the tool waited on, the error and the spend', () => {
    const html = draw(full);
    expect(html).toContain('Queued');
    expect(html).toContain('ticket_update');
    expect(html).toContain('The model connection refused the call.');
    expect(html).toContain('Part of run 00000000');
    expect(html).toContain('Triage');
    expect(html).toContain('$0.30');
    expect(html).toContain('5 minutes ago');
    expect(html).toContain('No spend ceiling is configured.');
    expect(html).toContain('There are more runs than this list shows');
  });

  it('says each list is empty, and that no ceiling is configured', () => {
    const html = draw(empty);
    for (const line of [
      'No agent is running right now.',
      'Nothing is waiting for a decision.',
      'No run failed in the last 24 hours.',
      'No run has started today.',
      'No spend ceiling is configured.',
    ]) {
      expect(html).toContain(line);
    }
    expect(html).not.toContain('<a ');
  });

  it('speaks Japanese', () => {
    const html = draw(full, 'ja');
    expect(headingsOf(html)).toEqual(['実行中', '判断待ち', '過去24時間の失敗', '本日の利用額']);
    expect(html).toContain('aria-label="ラン 00000000-0000-4000-8000-000000000001 を開く"');
    expect(html).toContain('利用額の上限は設定されていません。');
    expect(draw(empty, 'ja')).toContain('現在実行中のエージェントはありません。');
  });

  it('says it is loading before the first answer, and shows a problem as an alert', () => {
    expect(draw(null)).toContain('role="status"');
    const html = renderToStaticMarkup(
      <DashboardView platformUrl={PLATFORM} snapshot={empty} locale="en" problem="Sign in." />,
    );
    expect(html).toContain('<p class="aw-app-alert" role="alert">Sign in.</p>');
  });

  it('draws the lists the page’s server read, and the recipe slot after them', () => {
    const html = renderToStaticMarkup(
      <Dashboard
        platformUrl={PLATFORM}
        initial={full}
        recipeSteps={<p id="recipe-slot">Recipes</p>}
      />,
    );
    expect(headingsOf(html)).toHaveLength(4);
    expect(html.indexOf('recipe-slot')).toBeGreaterThan(html.indexOf('Spend today'));
  });
});
