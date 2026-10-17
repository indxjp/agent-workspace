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

import { StatusBadge } from './run-view';
import {
  badgeForRunStatus,
  RUN_POLL_INTERVAL_MS,
  describeRequestFailure,
  describeTransportRejection,
  formatDuration,
  formatProviderModel,
  formatCostDisplay,
  formatTimestamp,
  formatTokenCount,
  parseRunDetailResponse,
  reconcileDurableRun,
  runDetailPath,
  resolveResourceReference,
  shouldPollDurableRun,
  timestampAccessibilityLabel,
  type CatalogState,
  type RequestProblem,
  type ResourceReference,
  type RunListItem,
} from './history';

const CARD = 'rounded-(--radius) border border-border bg-surface shadow-(--shadow)';
const CALLOUT_DANGER =
  'flex items-start gap-[11px] rounded-(--radius) border border-danger bg-danger-soft p-[14px] text-[13px] text-danger';
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
}

type DetailLoad =
  | { readonly kind: 'loading' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'problem'; readonly problem: RequestProblem }
  | { readonly kind: 'loaded'; readonly run: RunListItem };

/**
 * Fetch `GET /api/runs/:id` once, or throw the same {@link DetailLoad} arm the caller should show
 * for a failure. Never throws for "the run does not exist" or "this workspace cannot see it" —
 * `readRun` in `apps/web/server/runs/api.ts` answers both with the identical `404 run_not_found`
 * (issue #117's concealment rule: a refused or foreign id reads exactly like a nonexistent one),
 * and this function passes that indistinguishability straight through as one `'not-found'` arm.
 */
export async function fetchRunDetail(runId: string): Promise<DetailLoad> {
  const path = runDetailPath(runId);
  if (path === null) {
    return {
      kind: 'problem',
      problem: { kind: 'transport', reason: 'The selected run id is not a canonical UUID.' },
    };
  }
  let response: Response;
  try {
    response = await fetch(path, { headers: { accept: 'application/json' } });
  } catch (error) {
    return { kind: 'problem', problem: describeTransportRejection(error) };
  }
  if (response.status === 404) return { kind: 'not-found' };
  if (!response.ok) {
    return {
      kind: 'problem',
      problem: await describeRequestFailure(response, () => response.json()),
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      kind: 'problem',
      problem: {
        kind: 'transport',
        reason: 'The server answered 200 with a body that was not JSON.',
      },
    };
  }
  try {
    return { kind: 'loaded', run: parseRunDetailResponse(body) };
  } catch (error) {
    return {
      kind: 'problem',
      problem: {
        kind: 'transport',
        reason: `The server's answer did not look like a run: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

export function RunDetailPanel({ runId, backHref, catalogs }: RunDetailPanelProps) {
  const [state, setState] = useState<DetailLoad>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function loop(): Promise<void> {
      const result = await fetchRunDetail(runId);
      if (cancelled) return;
      // The whole state is replaced by this single call's answer — see this file's header.
      setState((current) =>
        result.kind === 'loaded'
          ? {
              kind: 'loaded',
              run: reconcileDurableRun(current.kind === 'loaded' ? current.run : null, result.run),
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
        ← Back to Runs
      </Link>

      {state.kind === 'loading' ? <p className="text-[13px] text-muted">Loading run…</p> : null}

      {state.kind === 'not-found' ? (
        <div className={CARD}>
          <div className="p-5 text-[13px] text-muted">
            <p className="mt-0 mb-0">
              No run <span className="font-mono">{runId}</span> exists in this workspace.
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
            {state.problem.kind === 'api' ? (
              <>
                <b className="font-semibold">
                  {state.problem.status} {state.problem.code}
                </b>
                <div>{state.problem.message}</div>
              </>
            ) : (
              <div>{state.problem.reason}</div>
            )}
          </div>
        </div>
      ) : null}

      {state.kind === 'loaded' ? <LoadedRun run={state.run} catalogs={catalogs} /> : null}
    </div>
  );
}

function ReferenceCell({
  reference,
  hrefBase,
  emptyLabel,
  deletedLabel,
}: Readonly<{
  reference: ResourceReference;
  hrefBase: string;
  emptyLabel: string;
  deletedLabel: string;
}>) {
  if (reference.kind === 'absent') return <span className="text-muted">{emptyLabel}</span>;
  if (reference.kind === 'unknown') {
    return (
      <span className="text-muted">
        <span className="font-mono">{reference.id}</span>
        <span className="ml-1">(not available)</span>
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

function CostValue({ run }: Readonly<{ run: RunListItem }>) {
  return <>{formatCostDisplay(run)}</>;
}

function ExactTimestamp({ iso }: Readonly<{ iso: string | null }>) {
  if (iso === null) return <>—</>;
  return (
    <time dateTime={iso} title={iso} aria-label={timestampAccessibilityLabel(iso)}>
      {formatTimestamp(iso)}
    </time>
  );
}

function LoadedRun({
  run,
  catalogs,
}: Readonly<{ run: RunListItem; catalogs: RunDetailPanelCatalogs }>) {
  const agent = resolveResourceReference(run.agentId, catalogs.agents);
  const project = resolveResourceReference(run.projectId, catalogs.projects);
  const user = resolveResourceReference(run.initiatingUserId, catalogs.users);
  const workspace = resolveResourceReference(run.workspaceId, catalogs.workspaces);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <StatusBadge badge={badgeForRunStatus(run.status)} />
        <h1 className="m-0 text-[18px]">
          Run <span className="font-mono text-[14px] text-muted">{run.id}</span>
        </h1>
      </div>
      <p className="mt-0 mb-4 text-[13px] text-muted">
        Created <ExactTimestamp iso={run.createdAt} />
        {' · '}
        <Link
          href={`/api/sessions/${run.sessionId}`}
          className="text-accent no-underline hover:underline"
        >
          session data
        </Link>
        <span className="ml-1 text-[12px]">
          (raw — no session viewer is built yet; see this task's ADR)
        </span>
      </p>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Duration" value={formatDuration(run.durationMs, run.status)} />
        <StatCard label="Total tokens" value={formatTokenCount(run.usage.totalTokens)} />
        <StatCard label="Tool calls" value={formatTokenCount(run.usage.toolCalls)} />
        <StatCard label="Cost" value={<CostValue run={run} />} />
      </div>

      <div className={`${CARD} mb-5`}>
        <div className="p-4">
          <dl className={DETAIL_KV}>
            <dt>Status</dt>
            <dd>{run.status}</dd>
            <dt>Agent</dt>
            <dd>
              <ReferenceCell
                reference={agent}
                hrefBase="/agents"
                emptyLabel="No agent"
                deletedLabel="Deleted agent"
              />
            </dd>
            <dt>Project</dt>
            <dd>
              <ReferenceCell
                reference={project}
                hrefBase="/projects"
                emptyLabel="No project"
                deletedLabel="Deleted project"
              />
            </dd>
            <dt>Started by</dt>
            <dd>
              {user.kind === 'absent' ? (
                <span className="text-muted">Unknown</span>
              ) : user.kind === 'resolved' ? (
                user.label
              ) : user.kind === 'deleted' ? (
                <span className="text-muted">No longer a member</span>
              ) : (
                <span className="text-muted">Not available</span>
              )}
            </dd>
            <dt>Workspace</dt>
            <dd>
              {workspace.kind === 'resolved' ? (
                workspace.label
              ) : (
                <span className="font-mono text-muted">{run.workspaceId}</span>
              )}
            </dd>
            <dt>Provider / model</dt>
            <dd>{formatProviderModel(run.provider, run.model)}</dd>
          </dl>
        </div>
      </div>

      <h2 className="mb-3 text-[16px]">Technical details</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className={CARD} aria-labelledby="run-usage-heading">
          <div className="border-b border-border px-4 py-3">
            <h3 id="run-usage-heading" className="m-0 text-[14px] font-semibold">
              Usage
            </h3>
          </div>
          <div className="p-4">
            <dl className={DETAIL_KV}>
              <dt>Accounting state</dt>
              <dd>{run.accountingState}</dd>
              <dt>Cost</dt>
              <dd>
                <CostValue run={run} />
              </dd>
              <dt>Input tokens</dt>
              <dd>{formatTokenCount(run.usage.inputTokens)}</dd>
              <dt>Output tokens</dt>
              <dd>{formatTokenCount(run.usage.outputTokens)}</dd>
              <dt>Cache read</dt>
              <dd>{formatTokenCount(run.usage.cacheReadInputTokens)}</dd>
              <dt>Cache write</dt>
              <dd>{formatTokenCount(run.usage.cacheCreationInputTokens)}</dd>
              <dt>Total tokens</dt>
              <dd>{formatTokenCount(run.usage.totalTokens)}</dd>
              <dt>Tool calls</dt>
              <dd>{formatTokenCount(run.usage.toolCalls)}</dd>
              <dt>Price table</dt>
              <dd>{run.cost.priceTableVersion ?? 'Unavailable'}</dd>
              {run.accountingError === null ? null : (
                <>
                  <dt>Accounting error</dt>
                  <dd className="text-danger">{run.accountingError}</dd>
                </>
              )}
            </dl>
          </div>
        </section>

        <section className={CARD} aria-labelledby="run-runtime-heading">
          <div className="border-b border-border px-4 py-3">
            <h3 id="run-runtime-heading" className="m-0 text-[14px] font-semibold">
              Runtime
            </h3>
          </div>
          <div className="p-4">
            <dl className={DETAIL_KV}>
              <dt>Status</dt>
              <dd>{run.status}</dd>
              <dt>Provider / model</dt>
              <dd>{formatProviderModel(run.provider, run.model)}</dd>
              <dt>Duration</dt>
              <dd>{formatDuration(run.durationMs, run.status)}</dd>
              <dt>Created</dt>
              <dd>
                <ExactTimestamp iso={run.createdAt} />
              </dd>
              <dt>Started</dt>
              <dd>
                <ExactTimestamp iso={run.startedAt} />
              </dd>
              <dt>Ended</dt>
              <dd>
                <ExactTimestamp iso={run.endedAt} />
              </dd>
              <dt>Session</dt>
              <dd className="font-mono">{run.sessionId}</dd>
              {run.error === null ? null : (
                <>
                  <dt>Error</dt>
                  <dd className="text-danger">{run.error}</dd>
                </>
              )}
            </dl>
          </div>
        </section>
      </div>
    </div>
  );
}
