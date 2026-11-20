/**
 * The technical-details tabs: the three tabs the mockup puts inside the disclosure. The disclosure
 * itself stays closed by default; nothing here opens it (see `run-view.tsx`).
 */
import { useState } from 'react';
import type { EventLine, Run } from '@indx-workspace/react/run-model';
import type { RunViewStrings } from './run-view-messages';
import { Runs } from './run-view-parts';
import { BADGE, BADGE_TONE, CARD, KV } from './run-view-styles';

/** The three tabs the mockup puts inside the disclosure, in the mockup's order. */
const TABS = [
  { id: 'events', label: 'tabEvents' },
  { id: 'usage', label: 'tabUsage' },
  { id: 'runtime', label: 'tabRuntime' },
] as const satisfies readonly { readonly id: string; readonly label: keyof RunViewStrings }[];

type TabId = (typeof TABS)[number]['id'];
type Technical = Run['technical'];

/** `.event-log`. */
const EVENT_LOG = 'font-mono text-[12px] leading-[1.7]';
const EMPTY_LINE = 'mt-0 mb-0 text-[12.5px] text-muted';

export function TechnicalPanels({
  technical,
  strings,
}: {
  readonly technical: Technical;
  readonly strings: RunViewStrings;
}) {
  const [active, setActive] = useState<TabId>('events');

  return (
    <>
      <TabBar active={active} onSelect={setActive} strings={strings} />
      {active === 'events' ? <EventsPanel technical={technical} strings={strings} /> : null}
      {active === 'usage' ? <UsagePanel technical={technical} strings={strings} /> : null}
      {active === 'runtime' ? (
        <section>
          <EventLogCard lines={technical.runtimeEvents} empty={strings.noRuntimeEvents} />
        </section>
      ) : null}
    </>
  );
}

function TabBar({
  active,
  onSelect,
  strings,
}: {
  readonly active: TabId;
  readonly onSelect: (tab: TabId) => void;
  readonly strings: RunViewStrings;
}) {
  return (
    <div className="mb-[22px] flex gap-0.5 overflow-x-auto overflow-y-hidden border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          aria-pressed={tab.id === active}
          className={`-mb-px cursor-pointer border-0 border-b-2 bg-transparent px-3 py-[9px] text-[13.5px] whitespace-nowrap ${
            tab.id === active
              ? 'border-b-text font-semibold text-text'
              : 'border-b-transparent text-muted hover:text-text'
          }`}
          onClick={() => onSelect(tab.id)}
        >
          {strings[tab.label]}
        </button>
      ))}
    </div>
  );
}

function EventsPanel({
  technical,
  strings,
}: {
  readonly technical: Technical;
  readonly strings: RunViewStrings;
}) {
  return (
    <section>
      <EventLogCard lines={technical.sdkEvents} empty={strings.noSdkEvents} />
      {technical.sdkEventsNote === '' ? null : (
        <p className="mt-2 mb-0 text-[12.5px] text-muted">{technical.sdkEventsNote}</p>
      )}
    </section>
  );
}

function UsagePanel({
  technical,
  strings,
}: {
  readonly technical: Technical;
  readonly strings: RunViewStrings;
}) {
  return (
    <section>
      {technical.usageStats.length === 0 ? (
        <p className={EMPTY_LINE}>{strings.noUsage}</p>
      ) : (
        <UsageStats stats={technical.usageStats} />
      )}
      {technical.usageFacts.length === 0 ? null : <UsageFacts facts={technical.usageFacts} />}
    </section>
  );
}

function UsageStats({ stats }: { readonly stats: Technical['usageStats'] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(94px,1fr))] gap-px overflow-hidden rounded-(--radius) border border-border bg-border">
      {stats.map((stat) => (
        <div key={stat.id} className="bg-surface px-[15px] py-[13px]">
          <div className="text-[11.5px] tracking-[.04em] text-muted uppercase">{stat.label}</div>
          <div className="mt-[3px] text-[19px] font-semibold [font-variant-numeric:tabular-nums]">
            {stat.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function UsageFacts({ facts }: { readonly facts: Technical['usageFacts'] }) {
  return (
    <div className={`mt-4 ${CARD}`}>
      <div className="p-4">
        <dl className={KV}>
          {facts.map((fact) => (
            <div key={fact.term} className="contents">
              <dt className="text-[13px] text-muted">{fact.term}</dt>
              <dd className="m-0">
                {fact.badge === null ? null : (
                  <>
                    <span className={`${BADGE} ${BADGE_TONE[fact.badge.tone]} align-middle`}>
                      {fact.badge.label}
                    </span>{' '}
                  </>
                )}
                {fact.detail === '' ? null : (
                  <span className={fact.mono ? 'font-mono text-[12.5px]' : undefined}>
                    {fact.detail}
                  </span>
                )}
                {fact.note === null ? null : (
                  <span className="text-[12.5px] text-muted">
                    {' '}
                    <Runs paragraph={fact.note} />
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** A `.card` wrapping an `.event-log`, or the reason there is nothing in it. */
function EventLogCard({
  lines,
  empty,
}: {
  readonly lines: readonly EventLine[];
  readonly empty: string;
}) {
  if (lines.length === 0) {
    return <p className={EMPTY_LINE}>{empty}</p>;
  }
  return (
    <div className={`${CARD} max-h-[320px] overflow-auto`}>
      <div className={`p-4 ${EVENT_LOG}`}>
        {lines.map((line) => (
          <div key={line.id} className="flex gap-2.5 py-0.5">
            <span className="flex-none text-muted">{line.time}</span>
            <span className="w-[155px] flex-none text-accent">{line.event}</span>
            <span className="min-w-0 flex-1 text-text-2 [overflow-wrap:anywhere]">
              {line.detail}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
