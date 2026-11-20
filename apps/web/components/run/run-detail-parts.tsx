import Link from 'next/link';
import type { ReactNode } from 'react';

import type { VersionsLocale } from '../agents/versions-messages';
import {
  badgeForRunStatus,
  formatCostDisplay,
  formatTimestamp,
  timestampAccessibilityLabel,
  type ResourceReference,
  type RunListItem,
} from './history';
import { runHref } from './run-tree-model';
import { runStatusLabel } from './run-view-messages';
import type { RunsStrings } from './runs-messages';
import type { SpendCeilingNotice, SpendCeilingStrings } from './spend-ceiling-model';
import type { TeamStrings } from './team-messages';

export const CARD = 'rounded-(--radius) border border-border bg-surface shadow-(--shadow)';
export const CALLOUT_DANGER =
  'flex items-start gap-[11px] rounded-(--radius) border border-danger bg-danger-soft p-[14px] text-[13px] text-danger';
const CALLOUT_WARNING =
  'flex items-start gap-[11px] rounded-(--radius) border border-border bg-surface-2 p-[14px] text-[13px] text-text-2';
export const DETAIL_KV =
  'm-0 grid grid-cols-1 gap-x-4 gap-y-[11px] text-[13.5px] sm:grid-cols-[140px_minmax(0,1fr)] [&>dd]:m-0 [&>dd]:min-w-0 [&>dd]:[overflow-wrap:anywhere]';

/** English keeps the status's own name, as before; Japanese reads as the badge does. */
export function localizedStatus(status: RunListItem['status'], locale: VersionsLocale): string {
  return locale === 'en' ? status : runStatusLabel(badgeForRunStatus(status).label, locale);
}

export function ReferenceCell({
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

export function StatCard({ label, value }: Readonly<{ label: string; value: ReactNode }>) {
  return (
    <div className={`${CARD} px-[15px] py-[13px]`}>
      <div className="text-[11.5px] tracking-[.04em] text-muted uppercase">{label}</div>
      <div className="mt-[3px] text-[17px] font-semibold [font-variant-numeric:tabular-nums]">
        {value}
      </div>
    </div>
  );
}

export function CostValue({ run, strings }: Readonly<{ run: RunListItem; strings: RunsStrings }>) {
  return <>{formatCostDisplay(run, strings)}</>;
}

export function ExactTimestamp({ iso }: Readonly<{ iso: string | null }>) {
  if (iso === null) return <>—</>;
  return (
    <time dateTime={iso} title={iso} aria-label={timestampAccessibilityLabel(iso)}>
      {formatTimestamp(iso)}
    </time>
  );
}

/** Why a run stopped at its spend ceiling, or why its ceiling could not apply (ADR-0162). */
export function SpendCeilingCallout({
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

/** A child run's link back to the lead run that started it (ADR-0104). */
export function ParentRunNotice({
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
