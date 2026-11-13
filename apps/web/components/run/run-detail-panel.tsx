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
import { useEffect, useState, type ReactNode } from 'react';

import { browserClient } from '../../lib/browser-client';
import { ProblemDetail } from '../agents/problem-line';
import type { VersionsLocale } from '../agents/versions-messages';
import { continueChatHref } from '../composer/model';
import { browserLocale } from './attach-messages';
import { loadRunDetail, type DetailLoad } from './run-requests-model';
import { runHref, teamRows, treeCostDisplay, type RunTree } from './run-tree-model';
import { StatusBadge } from './run-view';
import {
  badgeForRunStatus,
  RUN_POLL_INTERVAL_MS,
  formatDuration,
  formatProviderModel,
  formatCostDisplay,
  formatTimestamp,
  formatTokenCount,
  reconcileDurableRun,
  resolveResourceReference,
  shouldPollDurableRun,
  timestampAccessibilityLabel,
  type CatalogState,
  type ResourceReference,
  type RunListItem,
} from './history';
import {
  spendCeilingAmount,
  spendCeilingNotice,
  spendCeilingStrings,
  type SpendCeilingNotice,
  type SpendCeilingStrings,
} from './spend-ceiling-model';
import { accountingStateText, runsStrings, type RunsStrings } from './runs-messages';
import { runStatusLabel } from './run-view-messages';
import { teamStrings, type TeamStrings } from './team-messages';

const CARD = 'rounded-(--radius) border border-border bg-surface shadow-(--shadow)';
const CALLOUT_DANGER =
  'flex items-start gap-[11px] rounded-(--radius) border border-danger bg-danger-soft p-[14px] text-[13px] text-danger';
const CALLOUT_WARNING =
  'flex items-start gap-[11px] rounded-(--radius) border border-border bg-surface-2 p-[14px] text-[13px] text-text-2';
const DETAIL_KV =
  'm-0 grid grid-cols-1 gap-x-4 gap-y-[11px] text-[13.5px] sm:grid-cols-[140px_minmax(0,1fr)] [&>dd]:m-0 [&>dd]:min-w-0 [&>dd]:[overflow-wrap:anywhere]';

export interface RunDetailPanelCatalogs {
  readonly agents: CatalogState;
  readonly projects: CatalogState;
  readonly users: CatalogState;
  readonly workspaces: CatalogState;
}

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

function ReferenceCell({
  reference,
  hrefBase,
  emptyLabel,
  deletedLabel,
  notAvailable,
}: Readonly<{
  reference: ResourceReference;
  hrefBase: string;
  emptyLabel: string;
  deletedLabel: string;
  notAvailable: string;
}>) {
  if (reference.kind === 'absent') return <span className="text-muted">{emptyLabel}</span>;
  if (reference.kind === 'unknown') {
    return (
      <span className="text-muted">
        <span className="font-mono">{reference.id}</span>
        <span className="ml-1">{notAvailable}</span>
      </span>
    );
  }
  if (reference.kind === 'deleted') {
    return <span className="text-muted">{deletedLabel}</span>;
  }
  return (
    <Link href={`${hrefBase}/${reference.id}`} className="text-accent no-underline hover:underline">
      {reference.label}
    </Link>
  );
}

function StatCard({ label, value }: Readonly<{ label: string; value: ReactNode }>) {
  return (
    <div className={`${CARD} px-[15px] py-[13px]`}>
      <div className="text-[11.5px] tracking-[.04em] text-muted uppercase">{label}</div>
      <div className="mt-[3px] text-[17px] font-semibold [font-variant-numeric:tabular-nums]">
        {value}
      </div>
    </div>
  );
}

function CostValue({ run, strings }: Readonly<{ run: RunListItem; strings: RunsStrings }>) {
  return <>{formatCostDisplay(run, strings)}</>;
}

function ExactTimestamp({ iso }: Readonly<{ iso: string | null }>) {
  if (iso === null) return <>—</>;
  return (
    <time dateTime={iso} title={iso} aria-label={timestampAccessibilityLabel(iso)}>
      {formatTimestamp(iso)}
    </time>
  );
}

export interface RunDetailBodyProps {
  readonly run: RunListItem;
  /** The run's children and tree cost (ADR-0104); empty for a run that is not a lead. */
  readonly tree: RunTree;
  readonly catalogs: RunDetailPanelCatalogs;
  readonly locale: VersionsLocale;
}

/** Why a run stopped at its spend ceiling, or why its ceiling could not apply (ADR-0162). */
function SpendCeilingCallout({
  notice,
  strings,
}: Readonly<{ notice: SpendCeilingNotice; strings: SpendCeilingStrings }>) {
  return (
    <div
      role="status"
      data-testid="run-spend-ceiling-notice"
      className={notice.kind === 'stopped' ? `${CALLOUT_DANGER} mb-4` : `${CALLOUT_WARNING} mb-4`}
    >
      {notice.kind === 'stopped' ? strings.stopped(notice.amount) : strings.unmeasured}
    </div>
  );
}

/** A loaded run: what the panel shows once `GET /api/runs/:id` has answered. */
export function RunDetailBody({ run, tree, catalogs, locale }: RunDetailBodyProps) {
  const strings = teamStrings(locale);
  const words = runsStrings(locale);
  // English keeps the status's own name, as before; Japanese reads as the badge does.
  const statusText =
    locale === 'en' ? run.status : runStatusLabel(badgeForRunStatus(run.status).label, locale);
  const ceilingStrings = spendCeilingStrings(locale);
  const ceilingNotice = spendCeilingNotice(run);
  const treeCost = treeCostDisplay(run, tree);
  const agent = resolveResourceReference(run.agentId, catalogs.agents);
  const project = resolveResourceReference(run.projectId, catalogs.projects);
  const user = resolveResourceReference(run.initiatingUserId, catalogs.users);
  const workspace = resolveResourceReference(run.workspaceId, catalogs.workspaces);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <StatusBadge badge={badgeForRunStatus(run.status)} locale={locale} />
        <h1 className="m-0 text-[18px]">
          {words.run} <span className="font-mono text-[14px] text-muted">{run.id}</span>
        </h1>
      </div>
      <p className="mt-0 mb-4 text-[13px] text-muted">
        {words.created} <ExactTimestamp iso={run.createdAt} />
        {' · '}
        {/* UX-05: the conversation this run belongs to, continued on the home chat. */}
        <Link
          href={continueChatHref(run.sessionId)}
          className="text-accent no-underline hover:underline"
        >
          {words.openConversation}
        </Link>
        {' · '}
        <Link
          href={`/api/sessions/${run.sessionId}`}
          className="text-[12px] text-muted no-underline hover:underline"
        >
          {words.rawSessionData}
        </Link>
      </p>
      {run.parentRunId === null ? null : (
        <ParentRunNotice parentRunId={run.parentRunId} strings={strings} />
      )}
      {ceilingNotice === null ? null : (
        <SpendCeilingCallout notice={ceilingNotice} strings={ceilingStrings} />
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label={words.duration}
          value={formatDuration(run.durationMs, run.status, words)}
        />
        <StatCard label={words.totalTokens} value={formatTokenCount(run.usage.totalTokens)} />
        <StatCard label={words.toolCalls} value={formatTokenCount(run.usage.toolCalls)} />
        <StatCard
          label={words.cost}
          value={
            <>
              <CostValue run={run} strings={words} />
              {run.spendCeilingUsd === null ? null : (
                <div
                  className="mt-1 text-[12.5px] font-normal text-text-2"
                  data-testid="run-spend-ceiling"
                >
                  {ceilingStrings.spendCeiling}:{' '}
                  <b className="font-semibold">{spendCeilingAmount(run.spendCeilingUsd)} USD</b>
                </div>
              )}
              {treeCost === null ? null : (
                <div
                  className="mt-1 text-[12.5px] font-normal text-text-2"
                  data-testid="run-tree-cost"
                >
                  {strings.treeCost}: <b className="font-semibold">{treeCost.amount}</b>
                  {treeCost.settled ? null : (
                    <span className="text-muted"> · {strings.treeCostUnsettled}</span>
                  )}
                </div>
              )}
            </>
          }
        />
      </div>

      <div className={`${CARD} mb-5`}>
        <div className="p-4">
          <dl className={DETAIL_KV}>
            <dt>{words.status}</dt>
            <dd>{statusText}</dd>
            <dt>{words.agent}</dt>
            <dd>
              <ReferenceCell
                reference={agent}
                hrefBase="/agents"
                emptyLabel={words.noAgent}
                deletedLabel={words.deletedAgent}
                notAvailable={words.notAvailableParen}
              />
            </dd>
            <dt>{words.project}</dt>
            <dd>
              <ReferenceCell
                reference={project}
                hrefBase="/projects"
                emptyLabel={words.noProject}
                deletedLabel={words.deletedProject}
                notAvailable={words.notAvailableParen}
              />
            </dd>
            <dt>{words.startedBy}</dt>
            <dd>
              {user.kind === 'absent' ? (
                <span className="text-muted">{words.unknown}</span>
              ) : user.kind === 'resolved' ? (
                user.label
              ) : user.kind === 'deleted' ? (
                <span className="text-muted">{words.noLongerMember}</span>
              ) : (
                <span className="text-muted">{words.notAvailable}</span>
              )}
            </dd>
            <dt>{words.workspace}</dt>
            <dd>
              {workspace.kind === 'resolved' ? (
                workspace.label
              ) : (
                <span className="font-mono text-muted">{run.workspaceId}</span>
              )}
            </dd>
            <dt>{words.providerModel}</dt>
            <dd>{formatProviderModel(run.provider, run.model, words)}</dd>
          </dl>
        </div>
      </div>

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
        <section className={CARD} aria-labelledby="run-usage-heading">
          <div className="border-b border-border px-4 py-3">
            <h3 id="run-usage-heading" className="m-0 text-[14px] font-semibold">
              {words.usage}
            </h3>
          </div>
          <div className="p-4">
            <dl className={DETAIL_KV}>
              <dt>{words.accountingState}</dt>
              <dd>{accountingStateText(run.accountingState, words)}</dd>
              <dt>{words.cost}</dt>
              <dd>
                <CostValue run={run} strings={words} />
              </dd>
              {run.spendCeilingUsd === null ? null : (
                <>
                  <dt>{ceilingStrings.spendCeiling}</dt>
                  <dd>{spendCeilingAmount(run.spendCeilingUsd)} USD</dd>
                </>
              )}
              <dt>{words.inputTokens}</dt>
              <dd>{formatTokenCount(run.usage.inputTokens)}</dd>
              <dt>{words.outputTokens}</dt>
              <dd>{formatTokenCount(run.usage.outputTokens)}</dd>
              <dt>{words.cacheRead}</dt>
              <dd>{formatTokenCount(run.usage.cacheReadInputTokens)}</dd>
              <dt>{words.cacheWrite}</dt>
              <dd>{formatTokenCount(run.usage.cacheCreationInputTokens)}</dd>
              <dt>{words.totalTokens}</dt>
              <dd>{formatTokenCount(run.usage.totalTokens)}</dd>
              <dt>{words.toolCalls}</dt>
              <dd>{formatTokenCount(run.usage.toolCalls)}</dd>
              <dt>{words.priceTable}</dt>
              <dd>{run.cost.priceTableVersion ?? words.unavailable}</dd>
              {run.accountingError === null ? null : (
                <>
                  <dt>{words.accountingError}</dt>
                  <dd lang="en" className="text-danger">
                    {run.accountingError}
                  </dd>
                </>
              )}
            </dl>
          </div>
        </section>

        <section className={CARD} aria-labelledby="run-runtime-heading">
          <div className="border-b border-border px-4 py-3">
            <h3 id="run-runtime-heading" className="m-0 text-[14px] font-semibold">
              {words.runtime}
            </h3>
          </div>
          <div className="p-4">
            <dl className={DETAIL_KV}>
              <dt>{words.status}</dt>
              <dd>{statusText}</dd>
              <dt>{words.providerModel}</dt>
              <dd>{formatProviderModel(run.provider, run.model, words)}</dd>
              <dt>{words.duration}</dt>
              <dd>{formatDuration(run.durationMs, run.status, words)}</dd>
              <dt>{words.created}</dt>
              <dd>
                <ExactTimestamp iso={run.createdAt} />
              </dd>
              <dt>{words.started}</dt>
              <dd>
                <ExactTimestamp iso={run.startedAt} />
              </dd>
              <dt>{words.ended}</dt>
              <dd>
                <ExactTimestamp iso={run.endedAt} />
              </dd>
              <dt>{words.session}</dt>
              <dd className="font-mono">{run.sessionId}</dd>
              {run.error === null ? null : (
                <>
                  <dt>{words.error}</dt>
                  {ceilingNotice?.kind === 'stopped' ? (
                    <dd className="text-danger">{ceilingStrings.stopped(ceilingNotice.amount)}</dd>
                  ) : (
                    // The run's own error, as the server recorded it.
                    <dd lang="en" className="text-danger">
                      {run.error}
                    </dd>
                  )}
                </>
              )}
            </dl>
          </div>
        </section>
      </div>
    </div>
  );
}

/** A child run's link back to the lead run that started it (ADR-0104). */
function ParentRunNotice({
  parentRunId,
  strings,
}: Readonly<{ parentRunId: string; strings: TeamStrings }>) {
  return (
    <p className="mt-0 mb-4 text-[13px] text-text-2" data-testid="run-parent">
      {strings.partOfTeamRun}
      {' · '}
      <Link href={runHref(parentRunId)} className="text-accent no-underline hover:underline">
        {strings.openLeadRun}
      </Link>
    </p>
  );
}

/**
 * The Team card: one collapsible row per child run, oldest first. A row is a native
 * `<details>`/`<summary>`, so it is reachable with Tab and toggled with Enter or Space, and its
 * summary is its accessible name (member, status, cost).
 */
function TeamCard({
  tree,
  agents,
  strings,
  words,
  locale,
}: Readonly<{
  tree: RunTree;
  agents: CatalogState;
  strings: TeamStrings;
  words: RunsStrings;
  locale: VersionsLocale;
}>) {
  return (
    <section className={`${CARD} mb-5`} aria-labelledby="run-team-heading" data-testid="run-team">
      <div className="border-b border-border px-4 py-3">
        <h2 id="run-team-heading" className="m-0 text-[14px] font-semibold">
          {strings.team}
        </h2>
        <p className="mt-1 mb-0 text-[12.5px] text-muted">{strings.teamDescription}</p>
      </div>
      <ul className="m-0 list-none p-0">
        {teamRows(tree, words).map((row) => {
          const agent = resolveResourceReference(row.agentId, agents);
          const name = agent.kind === 'resolved' ? agent.label : strings.unknownAgent;
          return (
            <li key={row.id} className="border-b border-border last:border-b-0">
              <details className="group">
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3 text-[13.5px] before:text-[10px] before:text-muted before:content-['▸'] group-open:before:content-['▾'] focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
                  <span className="font-semibold">{name}</span>
                  <StatusBadge badge={row.badge} locale={locale} />
                  <span className="ml-auto text-[12.5px] text-text-2 [font-variant-numeric:tabular-nums]">
                    {row.cost}
                  </span>
                </summary>
                <div className="px-4 pb-3">
                  <dl className={DETAIL_KV}>
                    <dt>{strings.member}</dt>
                    <dd>{name}</dd>
                    <dt>{strings.status}</dt>
                    <dd>
                      {locale === 'en'
                        ? row.status
                        : runStatusLabel(badgeForRunStatus(row.status).label, locale)}
                    </dd>
                    <dt>{strings.duration}</dt>
                    <dd>{formatDuration(row.durationMs, row.status, words)}</dd>
                    <dt>{strings.cost}</dt>
                    <dd>{row.cost}</dd>
                  </dl>
                  <Link
                    href={row.href}
                    className="mt-3 inline-block text-[13px] text-accent no-underline hover:underline"
                    aria-label={`${strings.openChildRun}: ${name}`}
                  >
                    {strings.openChildRun} →
                  </Link>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
