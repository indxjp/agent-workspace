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

import { Icon } from './icons';
import { activeNavId, visibleNavigation } from './navigation';

const ROW = 'mb-px flex items-center gap-[9px] rounded-(--radius-sm) px-2 py-1.5 text-[13.5px]';
const GLYPH = 'size-[15px] flex-none opacity-75';

export function SidebarNav({
  managers,
  features = FEATURE_IDS,
}: {
  readonly managers: boolean;
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
              {group.label}
            </div>
          )}
          {group.items
            .filter((item) => managers || item.managersOnly !== true)
            .map((item) =>
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
                  <span>{item.label}</span>
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
                  <span>{item.label}</span>
                </Link>
              ),
            )}
        </div>
      ))}
    </nav>
  );
}
