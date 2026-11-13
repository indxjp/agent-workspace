'use client';

/**
 * The sidebar's navigation list. A client component for one reason: the active entry is the one
 * whose route is on screen, and only the client knows the pathname — a layout is not re-rendered
 * per route and cannot be given it.
 *
 * Every class here is a translation of a rule in `ui/assets/app.css` (`.nav`, `.nav a`,
 * `.nav a.active`, `.nav .group-label`, `.nav a svg`), spending the same tokens. The pixel
 * values are arbitrary-value utilities rather than Tailwind's scale where the mockup's number is
 * not on the scale — 13.5px type, a 9px gap, a 15px glyph — because rounding them to the nearest
 * step would be redesigning the mockup.
 */
import { FEATURE_IDS, type FeatureId } from '@indx-workspace/contracts/features';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { continueChatHref } from '../composer/model';
import { Icon } from './icons';
import { activeNavId, visibleNavigation } from './navigation';
import { groupLabel, navLabel, shellStrings, type ShellLocale } from './shell-messages';

const ROW = 'mb-px flex items-center gap-[9px] rounded-(--radius-sm) px-2 py-1.5 text-[13.5px]';
const GLYPH = 'size-[15px] flex-none opacity-75';
/** `.nav .recent` and `.nav .recent-item` in `ui/assets/app.css`. */
const RECENT_ITEM =
  'block truncate rounded-(--radius-sm) px-2 py-1 text-[12.5px] no-underline hover:bg-surface-3 hover:no-underline';

/** One recent chat (spec §44): the session it opens and its label, `null` when it has none. */
export interface RecentChat {
  readonly id: string;
  readonly label: string | null;
}

/**
 * The signed-in person's recent chats, directly under New chat and newest first, then "See all"
 * into Runs (spec §44). Absent when there are none: no empty frame.
 */
function RecentChats({
  chats,
  locale,
}: {
  readonly chats: readonly RecentChat[];
  readonly locale: ShellLocale;
}) {
  if (chats.length === 0) return null;
  const strings = shellStrings(locale);
  return (
    <ul
      aria-label={strings.recentChats}
      className="m-0 mt-0.5 mb-2.5 ml-2 list-none border-l border-border p-0 pl-3"
    >
      {chats.map((chat) => (
        <li key={chat.id}>
          <Link
            href={continueChatHref(chat.id)}
            className={`${RECENT_ITEM} text-muted hover:text-text`}
          >
            {chat.label ?? strings.untitledChat}
          </Link>
        </li>
      ))}
      <li>
        <Link href="/runs" className={`${RECENT_ITEM} text-accent`}>
          {strings.seeAllChats}
        </Link>
      </li>
    </ul>
  );
}

export function SidebarNav({
  managers,
  features = FEATURE_IDS,
  locale = 'en',
  recent = [],
}: {
  readonly managers: boolean;
  /** The signed-in person's recent chats, shown under New chat; empty shows nothing. */
  readonly recent?: readonly RecentChat[];
  /** The reader's language (UX-15); the labels are §44's English unless it is `ja`. */
  readonly locale?: ShellLocale;
  /** The features switched on; an entry of any other feature is not shown (ADR-0160 D8). */
  readonly features?: readonly FeatureId[];
}) {
  const active = activeNavId(usePathname());

  return (
    <nav className="flex-1 overflow-y-auto px-2.5 py-3">
      {visibleNavigation(features).map((group, index) => (
        <div key={group.label ?? 'main'} className={index === 0 ? 'mt-0' : 'mt-[18px]'}>
          {group.label === null ? null : (
            <div className="px-2 pb-1.5 text-[11px] font-semibold tracking-[.06em] text-muted uppercase">
              {groupLabel(group, locale)}
            </div>
          )}
          {group.items
            .filter((item) => managers || item.managersOnly !== true)
            .flatMap((item) => [
              item.href === null ? (
                // No destination in this wave. Disabled in the design system's own idiom
                // (`.choice.disabled`: dimmed, not-allowed cursor) and announced to assistive
                // technology, rather than a link that answers a click with a 404.
                <span
                  key={item.id}
                  aria-disabled="true"
                  className={`${ROW} cursor-not-allowed text-text-2 opacity-[.62]`}
                >
                  <Icon name={item.icon} className={GLYPH} />
                  <span>{navLabel(item, locale)}</span>
                </span>
              ) : (
                <Link
                  key={item.id}
                  href={item.href}
                  aria-current={item.id === active ? 'page' : undefined}
                  className={
                    item.id === active
                      ? `${ROW} bg-surface font-semibold text-text no-underline shadow-(--shadow) hover:no-underline`
                      : `${ROW} text-text-2 no-underline hover:bg-surface-3 hover:text-text hover:no-underline`
                  }
                >
                  <Icon name={item.icon} className={GLYPH} />
                  <span>{navLabel(item, locale)}</span>
                </Link>
              ),
              // §44: the recent chats sit directly under New chat.
              item.id === 'home' ? (
                <RecentChats key="recent-chats" chats={recent} locale={locale} />
              ) : null,
            ])}
        </div>
      ))}
    </nav>
  );
}
