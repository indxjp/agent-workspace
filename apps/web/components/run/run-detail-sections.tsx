import Link from 'next/link';
import type { ReactNode } from 'react';

import type { VersionsLocale } from '../agents/versions-messages';
import { continueChatHref } from '../composer/model';
import { accountingStateText, type RunsStrings } from './runs-messages';
import {
  badgeForRunStatus,
  formatDuration,
  formatProviderModel,
  formatTokenCount,
  resolveResourceReference,
  type CatalogState,
  type RunListItem,
} from './history';
import {
  CARD,
  CostValue,
  DETAIL_KV,
  ExactTimestamp,
  ReferenceCell,
  StatCard,
} from './run-detail-parts';
import { treeCostDisplay, type RunTree } from './run-tree-model';
import { StatusBadge } from './run-view';
import {
  spendCeilingAmount,
  type SpendCeilingNotice,
  type SpendCeilingStrings,
} from './spend-ceiling-model';
import type { TeamStrings } from './team-messages';

interface RunSectionProps {
  readonly run: RunListItem;
  readonly words: RunsStrings;
  readonly statusText: string;
  readonly ceilingStrings: SpendCeilingStrings;
}

export interface RunReferenceCatalogs {
  readonly agents: CatalogState;
  readonly projects: CatalogState;
  readonly users: CatalogState;
  readonly workspaces: CatalogState;
}

export function RunHeader({
  run,
  words,
  locale,
}: Readonly<{ run: RunListItem; words: RunsStrings; locale: VersionsLocale }>) {
  return (
    <>
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
    </>
  );
}

const STAT_NOTE = 'mt-1 text-[12.5px] font-normal text-text-2';

function CostStatValue({
  run,
  words,
  strings,
  ceilingStrings,
  tree,
}: Readonly<{
  run: RunListItem;
  words: RunsStrings;
  strings: TeamStrings;
  ceilingStrings: SpendCeilingStrings;
  tree: RunTree;
}>) {
  const treeCost = treeCostDisplay(run, tree);
  return (
    <>
      <CostValue run={run} strings={words} />
      {run.spendCeilingUsd === null ? null : (
        <div className={STAT_NOTE} data-testid="run-spend-ceiling">
          {ceilingStrings.spendCeiling}:{' '}
          <b className="font-semibold">{spendCeilingAmount(run.spendCeilingUsd)} USD</b>
        </div>
      )}
      {treeCost === null ? null : (
        <div className={STAT_NOTE} data-testid="run-tree-cost">
          {strings.treeCost}: <b className="font-semibold">{treeCost.amount}</b>
          {treeCost.settled ? null : (
            <span className="text-muted"> · {strings.treeCostUnsettled}</span>
          )}
        </div>
      )}
    </>
  );
}

export function StatGrid({
  run,
  tree,
  words,
  strings,
  ceilingStrings,
}: Readonly<{
  run: RunListItem;
  tree: RunTree;
  words: RunsStrings;
  strings: TeamStrings;
  ceilingStrings: SpendCeilingStrings;
}>) {
  return (
    <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard label={words.duration} value={formatDuration(run.durationMs, run.status, words)} />
      <StatCard label={words.totalTokens} value={formatTokenCount(run.usage.totalTokens)} />
      <StatCard label={words.toolCalls} value={formatTokenCount(run.usage.toolCalls)} />
      <StatCard
        label={words.cost}
        value={
          <CostStatValue
            run={run}
            words={words}
            strings={strings}
            ceilingStrings={ceilingStrings}
            tree={tree}
          />
        }
      />
    </div>
  );
}

function StartedByValue({
  user,
  words,
}: Readonly<{
  user: ReturnType<typeof resolveResourceReference>;
  words: RunsStrings;
}>): ReactNode {
  switch (user.kind) {
    case 'absent':
      return <span className="text-muted">{words.unknown}</span>;
    case 'resolved':
      return user.label;
    case 'deleted':
      return <span className="text-muted">{words.noLongerMember}</span>;
    case 'unknown':
      return <span className="text-muted">{words.notAvailable}</span>;
  }
}

export function OverviewCard({
  run,
  words,
  statusText,
  catalogs,
}: Readonly<{
  run: RunListItem;
  words: RunsStrings;
  statusText: string;
  catalogs: RunReferenceCatalogs;
}>) {
  const agent = resolveResourceReference(run.agentId, catalogs.agents);
  const project = resolveResourceReference(run.projectId, catalogs.projects);
  const user = resolveResourceReference(run.initiatingUserId, catalogs.users);
  const workspace = resolveResourceReference(run.workspaceId, catalogs.workspaces);
  return (
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
            <StartedByValue user={user} words={words} />
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
  );
}

function DetailSection({
  headingId,
  title,
  children,
}: Readonly<{ headingId: string; title: string; children: ReactNode }>) {
  return (
    <section className={CARD} aria-labelledby={headingId}>
      <div className="border-b border-border px-4 py-3">
        <h3 id={headingId} className="m-0 text-[14px] font-semibold">
          {title}
        </h3>
      </div>
      <div className="p-4">
        <dl className={DETAIL_KV}>{children}</dl>
      </div>
    </section>
  );
}

export function UsageCard({ run, words, ceilingStrings }: Readonly<RunSectionProps>) {
  return (
    <DetailSection headingId="run-usage-heading" title={words.usage}>
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
    </DetailSection>
  );
}

function RunErrorRows({
  run,
  words,
  ceilingNotice,
  ceilingStrings,
}: Readonly<{
  run: RunListItem;
  words: RunsStrings;
  ceilingNotice: SpendCeilingNotice | null;
  ceilingStrings: SpendCeilingStrings;
}>) {
  if (run.error === null) return null;
  return (
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
  );
}

export function RuntimeCard({
  run,
  words,
  statusText,
  ceilingStrings,
  ceilingNotice,
}: Readonly<RunSectionProps & { ceilingNotice: SpendCeilingNotice | null }>) {
  return (
    <DetailSection headingId="run-runtime-heading" title={words.runtime}>
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
      <RunErrorRows
        run={run}
        words={words}
        ceilingNotice={ceilingNotice}
        ceilingStrings={ceilingStrings}
      />
    </DetailSection>
  );
}
