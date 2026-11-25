'use client';

/**
 * A run's result card on the run detail panel (ADR-0168): the charts the run's agent version's
 * surfaces declare in `resultCharts`, each drawn from the run's typed output
 * (`output.structured`, ADR-0143). A use case declares the chart and writes no chart code.
 *
 * A run with no typed output, or an unversioned one, renders nothing, and so does a version whose
 * surfaces declare no chart: a region with no data is absent, not an empty frame (W1-UI-03). A
 * reader who may not read the agent's versions sees no card; any other failed read says so, with a
 * retry.
 */
import type { AgentVersionListResponse } from '@indx-workspace/contracts/agent-versions';
import type { ResultChart as ResultChartSpec } from '@indx-workspace/contracts/surfaces';
import { ResultChart } from '@indx-workspace/react';
import { ApiProblemError } from '@indx-workspace/sdk';
import { useEffect, useState } from 'react';

import type { VersionsLocale } from '../agents/versions-messages';
import { browserClient } from '../../lib/browser-client';
import { errorText } from '../resources/resources-model';
import type { RunListItem } from './history';
import { CARD } from './run-detail-parts';

const STRINGS = {
  en: {
    heading: 'Result',
    failed: 'Could not read the charts for this result.',
    retry: 'Try again',
  },
  ja: {
    heading: '結果',
    failed: 'この結果のグラフを読み込めませんでした。',
    retry: 'もう一度',
  },
} as const satisfies Readonly<
  Record<VersionsLocale, { heading: string; failed: string; retry: string }>
>;

/** Reads an agent's versions: the SDK's `agents.versions.list`; tests pass their own. */
export type ListVersions = (agentId: string) => Promise<Pick<AgentVersionListResponse, 'items'>>;

/**
 * The charts version `version` of the agent declares, in surface order. A chart two surfaces both
 * declare is drawn once. A version that is not listed declares none.
 */
export async function loadResultCharts(
  listVersions: ListVersions,
  agentId: string,
  version: number,
): Promise<readonly ResultChartSpec[]> {
  const { items } = await listVersions(agentId);
  const body = items.find((item) => item.number === version)?.body;
  const charts = new Map<string, ResultChartSpec>();
  for (const surface of body?.surfaces ?? []) {
    for (const chart of surface.resultCharts ?? []) charts.set(JSON.stringify(chart), chart);
  }
  return [...charts.values()];
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly charts: readonly ResultChartSpec[] }
  | { readonly kind: 'failed'; readonly message: string };

export interface RunResultCardProps {
  readonly run: RunListItem;
  readonly locale: VersionsLocale;
  readonly listVersions?: ListVersions;
}

export function RunResultCard({ run, locale, listVersions }: RunResultCardProps) {
  const strings = STRINGS[locale];
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const structured = run.output?.structured ?? null;
  const typed = structured !== null && run.agentVersion !== null;
  const { agentId, agentVersion } = run;

  useEffect(() => {
    if (!typed || agentVersion === null) return;
    let current = true;
    setLoad({ kind: 'loading' });
    const list = listVersions ?? ((id: string) => browserClient().agents.versions.list(id));
    loadResultCharts(list, agentId, agentVersion).then(
      (charts) => {
        if (current) setLoad({ kind: 'ready', charts });
      },
      (error: unknown) => {
        if (!current) return;
        // A reader the versions route refuses or conceals them from has no charts to see.
        if (error instanceof ApiProblemError && (error.status === 403 || error.status === 404)) {
          setLoad({ kind: 'ready', charts: [] });
        } else {
          setLoad({ kind: 'failed', message: errorText(error) });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [typed, agentId, agentVersion, listVersions, attempt]);

  if (!typed || load.kind === 'loading') return null;
  if (load.kind === 'failed') {
    return (
      <div lang={locale} className="mb-5 text-[13px] text-text-2">
        <span role="alert">
          {strings.failed} <span className="text-muted">{load.message}</span>
        </span>{' '}
        <button
          type="button"
          onClick={() => setAttempt((count) => count + 1)}
          className="cursor-pointer border-0 bg-transparent p-0 text-accent underline"
        >
          {strings.retry}
        </button>
      </div>
    );
  }
  if (load.charts.length === 0) return null;
  return (
    <section lang={locale} aria-label={strings.heading} className={`${CARD} mb-5`}>
      <h2 className="border-b border-border px-4 py-[13px] text-[14px]">{strings.heading}</h2>
      <div className="grid gap-6 p-4">
        {load.charts.map((chart) => (
          <ResultChart
            key={JSON.stringify(chart)}
            chart={chart}
            structured={structured}
            locale={locale}
          />
        ))}
      </div>
    </section>
  );
}
