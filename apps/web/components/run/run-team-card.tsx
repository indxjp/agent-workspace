import Link from 'next/link';

import type { VersionsLocale } from '../agents/versions-messages';
import { formatDuration, resolveResourceReference, type CatalogState } from './history';
import { CARD, DETAIL_KV, localizedStatus } from './run-detail-parts';
import { teamRows, type RunTree } from './run-tree-model';
import { StatusBadge } from './run-view';
import type { RunsStrings } from './runs-messages';
import type { TeamStrings } from './team-messages';

type TeamRow = ReturnType<typeof teamRows>[number];

interface TeamMemberRowProps {
  readonly row: TeamRow;
  readonly name: string;
  readonly strings: TeamStrings;
  readonly words: RunsStrings;
  readonly locale: VersionsLocale;
}

const SUMMARY_CLASS =
  "flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3 text-[13.5px] before:text-[10px] before:text-muted before:content-['▸'] group-open:before:content-['▾'] focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden";

function TeamMemberRow({ row, name, strings, words, locale }: Readonly<TeamMemberRowProps>) {
  return (
    <li className="border-b border-border last:border-b-0">
      <details className="group">
        <summary className={SUMMARY_CLASS}>
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
            <dd>{localizedStatus(row.status, locale)}</dd>
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
}

/**
 * The Team card: one collapsible row per child run, oldest first. A row is a native
 * `<details>`/`<summary>`, so it is reachable with Tab and toggled with Enter or Space, and its
 * summary is its accessible name (member, status, cost).
 */
export function TeamCard({
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
            <TeamMemberRow
              key={row.id}
              row={row}
              name={name}
              strings={strings}
              words={words}
              locale={locale}
            />
          );
        })}
      </ul>
    </section>
  );
}
