/** The run view's right rail: one `.card` per rail card the run carries. */
import type { ReactNode } from 'react';
import type { RailCard } from '@indx-workspace/react/run-model';
import { Runs, StatusBadge, UnbuiltButton } from './run-view-parts';
import { CARD, KV } from './run-view-styles';

/** `.card .card-head`. */
const CARD_HEAD = 'flex items-center gap-3 border-b border-border px-4 py-[13px]';

type CardOf<K extends RailCard['kind']> = Extract<RailCard, { readonly kind: K }>;

/** The `.card` frame every rail card shares: a titled head over a padded body. */
function RailFrame({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className={CARD}>
      <div className={CARD_HEAD}>
        <h3 className="text-[14px]">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function FactsBody({ card }: { readonly card: CardOf<'facts'> }) {
  return (
    <dl className={`${KV} sm:grid-cols-[105px_minmax(0,1fr)]`}>
      {card.facts.map((fact) => (
        <div key={fact.term} className="contents">
          <dt className="text-[13px] text-muted">{fact.term}</dt>
          <dd className="m-0">
            {fact.badge === null ? null : <StatusBadge badge={fact.badge} />}
            {fact.detail === '' ? null : fact.detail}
            {fact.note === null ? null : (
              <div className="text-[12.5px] text-muted">
                <Runs paragraph={fact.note} />
              </div>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function GroupsBody({ card }: { readonly card: CardOf<'groups'> }) {
  return (
    <>
      {card.groups.map((group, index) => (
        <div key={group.label}>
          <div className={`mb-2 text-[12.5px] text-muted ${index === 0 ? '' : 'mt-4'}`}>
            {group.label}
          </div>
          <div className="font-mono text-[12.5px]">{group.items.join(' · ')}</div>
        </div>
      ))}
    </>
  );
}

function FilesBody({ card }: { readonly card: CardOf<'files'> }) {
  return (
    <>
      <div className="overflow-hidden rounded-(--radius) border border-border bg-surface">
        {card.files.map((file) => (
          <div
            key={file.id}
            className="flex items-center gap-3.5 border-b border-border px-3 py-2.5 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13.5px] font-semibold">
                {file.title}
              </div>
              <div className="mt-0.5 text-[12.5px] text-muted">{file.meta}</div>
            </div>
            {file.action === null ? null : (
              <div className="flex items-center gap-3.5">
                <UnbuiltButton action={file.action} small />
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="mt-2 mb-0 text-[12.5px] text-muted">{card.footnote}</p>
    </>
  );
}

/** One rail `.card`. Total over {@link RailCard}; the mockup draws exactly these three shapes. */
export function RailCardView({ card }: { readonly card: RailCard }) {
  switch (card.kind) {
    case 'facts':
      return (
        <RailFrame title={card.title}>
          <FactsBody card={card} />
        </RailFrame>
      );
    case 'groups':
      return (
        <RailFrame title={card.title}>
          <GroupsBody card={card} />
        </RailFrame>
      );
    case 'files':
      return (
        <RailFrame title={card.title}>
          <FilesBody card={card} />
        </RailFrame>
      );
    default: {
      const unknown: never = card;
      throw new TypeError(`no rail card of kind ${JSON.stringify(unknown)} can be shown`);
    }
  }
}
