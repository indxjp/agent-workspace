import { fetchDouble, jsonResponse } from '@indx-workspace/sdk/testing';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { RecipeRunDetail, RecipeStepView } from '../recipe-wire.js';
import { appStrings, type AppLocale } from './locale.js';
import { recipeClient } from './recipe-client.js';
import {
  RecipeGraph,
  RecipeGraphView,
  RecipeRunList,
  type RecipeGraphViewProps,
} from './recipe-graph.js';
import { changeAnnouncement } from './recipe-graph-model.js';

const RUN_ID = '00000000-0000-4000-8000-000000000010';
const CALL = { toolName: 'ticket_update', canonicalCall: '{"assignee":"Net"}' };

function step(key: string, overrides: Partial<RecipeStepView>): RecipeStepView {
  return {
    key,
    status: 'completed',
    runId: `run-${key}`,
    runUrl: `https://aw.test/runs?run=run-${key}`,
    decision: null,
    error: null,
    startedAt: '2026-11-01T09:00:00.000000Z',
    endedAt: '2026-11-01T09:00:04.200000Z',
    cost: { amount: '0.0123', currency: 'USD' },
    pendingApproval: null,
    ...overrides,
  };
}

const detail: RecipeRunDetail = {
  run: {
    id: RUN_ID,
    recipe: 'triage-incident',
    status: 'waiting',
    error: null,
    startedBy: null,
    createdAt: '2026-11-01T09:00:00.000000Z',
    updatedAt: '2026-11-01T09:00:00.000000Z',
  },
  steps: [
    step('classify', {}),
    step('enrich', { status: 'failed', error: 'model_unavailable' }),
    step('assign', {
      status: 'awaiting_approval',
      endedAt: null,
      startedAt: '2026-11-01T09:00:05.000000Z',
      pendingApproval: CALL,
    }),
    step('notify', {
      status: 'running',
      endedAt: null,
      runId: null,
      runUrl: null,
      cost: null,
      startedAt: '2026-11-01T09:00:06.000000Z',
    }),
  ],
};

function viewProps(overrides: Partial<RecipeGraphViewProps> = {}): RecipeGraphViewProps {
  const locale: AppLocale = overrides.locale ?? 'en';
  return {
    detail,
    strings: appStrings(locale),
    locale,
    announcement: '',
    problem: null,
    deciding: null,
    onDecide: () => undefined,
    ...overrides,
  };
}

const draw = (overrides: Partial<RecipeGraphViewProps> = {}): string =>
  renderToStaticMarkup(<RecipeGraphView {...viewProps(overrides)} />);

/** Every `<button>` the view draws, its props as given, its parts' functions called in turn. */
function buttonsOf(node: ReactNode): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => buttonsOf(child));
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === 'function') {
    const part = element.type as (props: Record<string, unknown>) => ReactNode;
    return buttonsOf(part(element.props));
  }
  const own = element.type === 'button' ? [element.props] : [];
  return [...own, ...buttonsOf(element.props['children'] as ReactNode)];
}

describe('RecipeGraphView (#1514)', () => {
  it('draws every step in order, with its status, duration, cost and run link', () => {
    const html = draw();
    const keys = [...html.matchAll(/<h3 class="aw-app-recipe-step-key">([^<]+)<\/h3>/gu)].map(
      (match) => match[1],
    );
    expect(keys).toEqual(['classify', 'enrich', 'assign', 'notify']);
    for (const status of ['running', 'awaiting_approval', 'completed', 'failed']) {
      expect(html).toContain(`data-status="${status}"`);
    }
    for (const label of [
      'Running',
      'Awaiting approval',
      'Completed',
      'Failed: model_unavailable',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('4.2 sec');
    expect(html).toContain('$0.0123');
    expect(html).toContain('href="https://aw.test/runs?run=run-classify"');
    expect(html).toContain('aria-label="Open run of step classify in Agent Workspace"');
    expect(html).toContain(
      '<ol class="aw-app-recipe-steps" aria-label="Steps of triage-incident">',
    );
  });

  it('shows the pending call and Approve / Reject only on the step that waits', () => {
    const html = draw();
    expect(html).toContain('ticket_update');
    expect(html).toContain('{&quot;assignee&quot;:&quot;Net&quot;}');
    expect(html.match(/<button/gu)).toHaveLength(2);
    expect(html).toContain('aria-label="Approve step assign"');
    expect(html).toContain('aria-label="Reject step assign"');
  });

  it('Approve and Reject call onDecide with the step and the decision', () => {
    const onDecide = vi.fn();
    const buttons = buttonsOf(RecipeGraphView(viewProps({ onDecide })));
    expect(buttons.map((button) => button['aria-label'])).toEqual([
      'Approve step assign',
      'Reject step assign',
    ]);
    for (const button of buttons) (button['onClick'] as () => void)();
    expect(onDecide.mock.calls).toEqual([
      ['assign', 'approve'],
      ['assign', 'reject'],
    ]);
  });

  it('disables both buttons and says so while a decision is sent', () => {
    const html = draw({ deciding: 'assign' });
    expect(html.match(/<button[^>]* disabled=""/gu)).toHaveLength(2);
    expect(html).toContain('Sending your decision…');
  });

  it('announces a status change in a polite live region', () => {
    const after: RecipeRunDetail = {
      ...detail,
      steps: detail.steps.map((each) =>
        each.key === 'assign' ? { ...each, status: 'completed', pendingApproval: null } : each,
      ),
    };
    const said = changeAnnouncement(detail, after, appStrings('en').recipes) ?? '';
    expect(said).toBe('Step assign: Completed.');
    const html = draw({ detail: after, announcement: said });
    expect(html).toContain(
      '<p class="aw-app-status" role="status" aria-live="polite">Step assign: Completed.</p>',
    );
  });

  it('names every button, and never makes a div a button', () => {
    for (const locale of ['en', 'ja'] as const) {
      const html = draw({ locale });
      expect(html).not.toMatch(/role="button"/u);
      for (const tag of html.match(/<button[^>]*>/gu) ?? []) {
        expect(tag).toMatch(/aria-label="[^"]+"/u);
        expect(tag).toContain('type="button"');
      }
      const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
      for (const [, referenced] of html.matchAll(/aria-labelledby="([^"]+)"/gu)) {
        expect(ids).toContain(referenced);
      }
    }
  });

  it('speaks Japanese and English', () => {
    const ja = draw({ locale: 'ja' });
    expect(ja).toContain('承認待ち');
    expect(ja).toContain('aria-label="ステップ assign を承認"');
    expect(ja).toContain('ランを開く');
    expect(ja).toContain('この呼び出しの承認を待っています');
    const en = draw();
    expect(en).toContain('Waiting for your approval of this call');
    expect(en).toContain('Waiting for a decision');
  });

  it('shows a problem as an alert, and a loading heading before the first answer', () => {
    expect(draw({ problem: 'Someone already decided this step.' })).toContain(
      '<p class="aw-app-alert" role="alert">Someone already decided this step.</p>',
    );
    const loading = draw({ detail: null });
    expect(loading).toContain('Loading…');
    expect(loading).not.toContain('<ol');
  });
});

describe('RecipeGraph and RecipeRunList (#1514)', () => {
  const never = recipeClient({ fetch: () => new Promise<Response>(() => undefined) });

  it('draws the graph from the run the page read', () => {
    const html = renderToStaticMarkup(
      <RecipeGraph recipeRunId={RUN_ID} initial={detail} client={never} />,
    );
    expect(html).toContain('triage-incident');
    expect(html).toContain('aria-live="polite"');
  });

  it('lists the runs, each linking to its graph', () => {
    const html = renderToStaticMarkup(
      <RecipeRunList
        initial={{ items: [detail.run], nextCursor: 'next' }}
        client={never}
        locale="ja"
      />,
    );
    expect(html).toContain(`href="/recipes/${RUN_ID}"`);
    expect(html).toContain('<caption class="aw-app-sr-only">レシピの実行</caption>');
    expect(html).toContain('判断待ち');
    expect(html).toContain('さらに読み込む');
    expect(
      renderToStaticMarkup(
        <RecipeRunList initial={{ items: [], nextCursor: null }} client={never} />,
      ),
    ).toContain('No recipe has run yet.');
  });
});

describe('recipeClient (#1514)', () => {
  it('posts a decision to the step decision route and reads the run back', async () => {
    const double = fetchDouble(() => jsonResponse(200, detail));
    const client = recipeClient({ baseUrl: 'https://app.test/', fetch: double.fetch });
    const answer = await client.decide(RUN_ID, 'assign', 'approve');
    expect(answer.run.id).toBe(RUN_ID);
    const [call] = double.calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.href).toBe(
      `https://app.test/api/recipes/runs/${RUN_ID}/steps/assign/decision`,
    );
    expect(call?.json).toEqual({ decision: 'approve' });
    await client.decide(RUN_ID, 'assign', 'reject', 'not now');
    expect(double.calls[1]?.json).toEqual({ decision: 'reject', comment: 'not now' });
  });

  it('lists with its filters, and turns a refusal into its code', async () => {
    const double = fetchDouble((request) =>
      request.url.pathname.endsWith('/runs')
        ? jsonResponse(200, { items: [], nextCursor: null })
        : jsonResponse(404, { error: { code: 'recipe_run_not_found', message: 'no' } }),
    );
    const client = recipeClient({ fetch: double.fetch, baseUrl: 'https://app.test' });
    await client.list({ recipe: 'sla-sweep', status: 'waiting', cursor: 'c' });
    expect(double.calls[0]?.url.search).toBe('?recipe=sla-sweep&status=waiting&cursor=c');
    await expect(client.get(RUN_ID)).rejects.toMatchObject({
      code: 'recipe_run_not_found',
      status: 404,
    });
    const broken = recipeClient({ fetch: () => Promise.reject(new TypeError('offline')) });
    await expect(broken.get(RUN_ID)).rejects.toMatchObject({ code: 'transport_failed' });
  });
});
