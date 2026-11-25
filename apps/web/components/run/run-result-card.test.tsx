// @vitest-environment happy-dom
import type { ResultChart } from '@indx-workspace/contracts/surfaces';
import { ApiProblemError } from '@indx-workspace/sdk';
import { fixtures } from '@indx-workspace/sdk/testing';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunListItem } from './history';
import { MOCKUP_TEAM_LEAD } from './mockup-fixture';
import {
  loadResultCharts,
  RunResultCard,
  type ListVersions,
  type RunResultCardProps,
} from './run-result-card';

const client = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../../lib/browser-client', () => ({
  browserClient: () => ({ agents: { versions: { list: client.list } } }),
}));

type VersionList = Awaited<ReturnType<ListVersions>>;

const CHART: ResultChart = {
  kind: 'bar',
  field: 'sites',
  label: 'site',
  value: 'sales',
  title: { ja: '拠点別売上', en: 'Sales by site' },
  axes: { label: { ja: '拠点', en: 'Site' }, value: { ja: '売上', en: 'Sales' } },
};
const TREND: ResultChart = { ...CHART, kind: 'line', title: { ja: '推移', en: 'Trend' } };

const TYPED_RUN: RunListItem = {
  ...MOCKUP_TEAM_LEAD,
  output: { text: '東京が最大です。', structured: { sites: [{ site: '東京', sales: 1200 }] } },
};

/** Version 1 of the fixture agent, its surfaces declaring `charts` each (none for an empty list). */
function versions(...surfaces: (readonly ResultChart[])[]): VersionList {
  const base = fixtures.agentVersion();
  const declared = surfaces.map((charts, index) => ({
    name: `s${String(index)}`,
    agent: base.body.definition.agent.name,
    ...(charts.length === 0 ? {} : { resultCharts: charts }),
  }));
  return {
    items: [
      fixtures.agentVersion({ body: { ...base.body, surfaces: declared } }),
      fixtures.agentVersion({ number: 2 }),
    ],
  };
}

const problem = (status: number, code: string) =>
  new ApiProblemError({ status, problem: { code, message: 'No.' } });

let root: Root | undefined;

async function render(props: RunResultCardProps): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<RunResultCard {...props} />);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe('loadResultCharts', () => {
  it('collects the charts of the run’s version, in surface order, each once', async () => {
    const list = vi.fn<ListVersions>(() => Promise.resolve(versions([CHART], [], [TREND, CHART])));
    await expect(loadResultCharts(list, 'agent-1', 1)).resolves.toEqual([CHART, TREND]);
    expect(list).toHaveBeenCalledWith('agent-1');
    await expect(loadResultCharts(list, 'agent-1', 2)).resolves.toEqual([]);
    await expect(loadResultCharts(list, 'agent-1', 9)).resolves.toEqual([]);
  });
});

// ADR-0168: the run detail panel's result card draws the charts the surface declared.
describe('RunResultCard', () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('draws each declared chart from the run’s typed output', async () => {
    const listVersions = vi.fn<ListVersions>(() => Promise.resolve(versions([CHART, TREND])));
    const view = await render({ run: TYPED_RUN, locale: 'en', listVersions });
    expect(listVersions).toHaveBeenCalledWith(TYPED_RUN.agentId);
    expect(view.querySelector('section')?.getAttribute('aria-label')).toBe('Result');
    expect([...view.querySelectorAll('figcaption')].map((caption) => caption.textContent)).toEqual([
      'Sales by site',
      'Trend',
    ]);
    expect(view.querySelectorAll('table')).toHaveLength(2);
  });

  it('reads the versions through the browser client by default', async () => {
    client.list.mockResolvedValueOnce(versions([CHART]));
    const view = await render({ run: TYPED_RUN, locale: 'en' });
    expect(client.list).toHaveBeenCalledWith(TYPED_RUN.agentId);
    expect(view.querySelector('figcaption')?.textContent).toBe('Sales by site');
  });

  it('heads the card in Japanese', async () => {
    const listVersions = () => Promise.resolve(versions([CHART]));
    const view = await render({ run: TYPED_RUN, locale: 'ja', listVersions });
    expect(view.querySelector('h2')?.textContent).toBe('結果');
    expect(view.querySelector('figcaption')?.textContent).toBe('拠点別売上');
  });

  it('renders nothing for an untyped, unanswered or unversioned run, without reading versions', async () => {
    const listVersions = vi.fn<ListVersions>(() => Promise.resolve(versions([CHART])));
    for (const run of [
      MOCKUP_TEAM_LEAD,
      { ...TYPED_RUN, output: null },
      { ...TYPED_RUN, agentVersion: null },
    ]) {
      const view = await render({ run, locale: 'en', listVersions });
      expect(view.innerHTML).toBe('');
      act(() => root?.unmount());
    }
    expect(listVersions).not.toHaveBeenCalled();
  });

  it('renders nothing when no surface declares a chart, or the reader may not read versions', async () => {
    const answers: (() => Promise<VersionList>)[] = [
      () => Promise.resolve(versions([])),
      () => Promise.reject(problem(403, 'forbidden')),
      () => Promise.reject(problem(404, 'agent_not_found')),
    ];
    for (const listVersions of answers) {
      const view = await render({ run: TYPED_RUN, locale: 'en', listVersions });
      expect(view.innerHTML).toBe('');
      act(() => root?.unmount());
    }
  });

  it('says a failed read failed, and tries again on request', async () => {
    const listVersions = vi
      .fn<ListVersions>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(versions([CHART]));
    const view = await render({ run: TYPED_RUN, locale: 'en', listVersions });
    const alert = view.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Could not read the charts for this result.');
    expect(alert?.textContent).toContain('network down');
    await act(async () => {
      view.querySelector('button')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(listVersions).toHaveBeenCalledTimes(2);
    expect(view.querySelector('figcaption')?.textContent).toBe('Sales by site');
  });

  it('ignores an answer that arrives after it unmounted', async () => {
    let resolve: (value: VersionList) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const pending = () =>
      new Promise<VersionList>((done, fail) => {
        resolve = done;
        reject = fail;
      });
    await render({ run: TYPED_RUN, locale: 'en', listVersions: pending });
    act(() => root?.unmount());
    root = undefined;
    resolve(versions([CHART]));
    await render({ run: TYPED_RUN, locale: 'en', listVersions: pending });
    act(() => root?.unmount());
    root = undefined;
    reject(new Error('late'));
    await Promise.resolve();
    expect(document.body.textContent).toBe('');
  });
});
