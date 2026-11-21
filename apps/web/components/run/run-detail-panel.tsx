'use client';

/**
 * The run detail panel — issue #136, selected by `?run=<id>` on `/runs`
 * (`docs/adr/W9-PLAN-run-detail-is-a-panel-not-a-new-screen.md`: no new route, no new mockup).
 *
 * Everything shown here is read straight from `GET /api/runs/:id` (`renderRun` in
 * `apps/web/server/runs/api.ts`, the same shaping `GET /api/runs` uses — issue #135's "list and
 * detail cannot drift"). Nothing here reads the process-local telemetry map, including as a
 * fallback: a failed fetch is shown as a failure, never silently answered from a source with weaker
 * guarantees (`docs/adr/W9-PLAN-metrics-is-operational-not-product.md`).
 *
 * ## "Replacing, never adding" (the task card's own words)
 *
 * While a run is `queued` or `running`, this component re-fetches `GET /api/runs/:id` on a timer
 * and **replaces** its whole `run` state with what that fetch answers. There is no second,
 * incremental source of truth here (no SSE subscription, no local counter this component adds
 * to) — every render shows exactly one durable snapshot, so the figures on screen the moment
 * before a run finishes and the figures a reload shows afterwards are, by construction, the same
 * request answered twice, never a live estimate summed with a durable ledger.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { browserClient } from '../../lib/browser-client';
import { ProblemDetail } from '../agents/problem-line';
import type { VersionsLocale } from '../agents/versions-messages';
import { browserLocale } from './attach-messages';
import {
  RUN_POLL_INTERVAL_MS,
  reconcileDurableRun,
  shouldPollDurableRun,
  type RunListItem,
} from './history';
import {
  CALLOUT_DANGER,
  CARD,
  ParentRunNotice,
  SpendCeilingCallout,
  localizedStatus,
} from './run-detail-parts';
import {
  OverviewCard,
  RunHeader,
  RuntimeCard,
  StatGrid,
  UsageCard,
  type RunReferenceCatalogs,
} from './run-detail-sections';
import { loadRunDetail, type DetailLoad } from './run-requests-model';
import { RunResultCard } from './run-result-card';
import type { RunTree } from './run-tree-model';
import { TeamCard } from './run-team-card';
import { runsStrings } from './runs-messages';
import { spendCeilingNotice, spendCeilingStrings } from './spend-ceiling-model';
import { teamStrings } from './team-messages';

export type RunDetailPanelCatalogs = RunReferenceCatalogs;

export interface RunDetailPanelProps {
  readonly runId: string;
  /** Where "← Back to Runs" returns to — the list, with every other filter preserved. */
  readonly backHref: string;
  readonly catalogs: RunDetailPanelCatalogs;
  /**
   * The reader's language (UX-15 in #2086), as the page negotiated it. Without one the panel asks
   * the browser, as it did before the Runs screen was translated.
   */
  readonly locale?: VersionsLocale;
}

export function RunDetailPanel({ runId, backHref, catalogs, locale: given }: RunDetailPanelProps) {
  const [state, setState] = useState<DetailLoad>({ kind: 'loading' });
  const [browser, setBrowser] = useState<VersionsLocale>('en');
  useEffect(() => setBrowser(browserLocale(navigator.languages)), []);
  const locale = given ?? browser;
  const strings = runsStrings(locale);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function loop(): Promise<void> {
      const result = await loadRunDetail(browserClient(), runId);
      if (cancelled) return;
      // The whole state is replaced by this single call's answer — see this file's header.
      setState((current) =>
        result.kind === 'loaded'
          ? {
              kind: 'loaded',
              run: reconcileDurableRun(current.kind === 'loaded' ? current.run : null, result.run),
              tree: result.tree,
            }
          : result,
      );
      if (result.kind === 'loaded' && shouldPollDurableRun(result.run)) {
        timer = setTimeout(() => {
          void loop();
        }, RUN_POLL_INTERVAL_MS);
      }
    }

    setState({ kind: 'loading' });
    void loop();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [runId]);

  return (
    <div>
      <Link
        href={backHref}
        className="mb-4 inline-block text-[13px] text-muted no-underline hover:underline"
      >
        {strings.backToRuns}
      </Link>

      {state.kind === 'loading' ? (
        <p className="text-[13px] text-muted">{strings.loadingRun}</p>
      ) : null}

      {state.kind === 'not-found' ? (
        <div className={CARD}>
          <div className="p-5 text-[13px] text-muted">
            <p className="mt-0 mb-0">
              {strings.noRunBefore}
              <span className="font-mono">{runId}</span>
              {strings.noRunAfter}
            </p>
          </div>
        </div>
      ) : null}

      {state.kind === 'problem' ? (
        <div className={CALLOUT_DANGER} role="alert">
          <span aria-hidden="true" className="flex-none text-[14px] leading-[1.4]">
            !
          </span>
          <div className="min-w-0 flex-1">
            <ProblemDetail locale={locale} lead={strings.runLoadFailed} problem={state.problem} />
          </div>
        </div>
      ) : null}

      {state.kind === 'loaded' ? (
        <RunDetailBody run={state.run} tree={state.tree} catalogs={catalogs} locale={locale} />
      ) : null}
    </div>
  );
}

export interface RunDetailBodyProps {
  readonly run: RunListItem;
  /** The run's children and tree cost (ADR-0104); empty for a run that is not a lead. */
  readonly tree: RunTree;
  readonly catalogs: RunDetailPanelCatalogs;
  readonly locale: VersionsLocale;
}

/** A loaded run: what the panel shows once `GET /api/runs/:id` has answered. */
export function RunDetailBody({ run, tree, catalogs, locale }: RunDetailBodyProps) {
  const strings = teamStrings(locale);
  const words = runsStrings(locale);
  const statusText = localizedStatus(run.status, locale);
  const ceilingStrings = spendCeilingStrings(locale);
  const ceilingNotice = spendCeilingNotice(run);
  const section = { run, words, statusText, ceilingStrings };

  return (
    <div>
      <RunHeader run={run} words={words} locale={locale} />
      {run.parentRunId === null ? null : (
        <ParentRunNotice parentRunId={run.parentRunId} strings={strings} />
      )}
      {ceilingNotice === null ? null : (
        <SpendCeilingCallout notice={ceilingNotice} strings={ceilingStrings} />
      )}
      <StatGrid
        run={run}
        tree={tree}
        words={words}
        strings={strings}
        ceilingStrings={ceilingStrings}
      />
      <OverviewCard run={run} words={words} statusText={statusText} catalogs={catalogs} />
      <RunResultCard run={run} locale={locale} />

      {tree.children.length === 0 ? null : (
        <TeamCard
          tree={tree}
          agents={catalogs.agents}
          strings={strings}
          words={words}
          locale={locale}
        />
      )}

      <h2 className="mb-3 text-[16px]">{words.technicalDetails}</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <UsageCard {...section} />
        <RuntimeCard {...section} ceilingNotice={ceilingNotice} />
      </div>
    </div>
  );
}
