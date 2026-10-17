'use client';

/**
 * The top bar: the breadcrumb trail on the left, the runtime chip on the right.
 *
 * Transcribed from `.topbar`, `.crumbs` and `.runtime-chip` in `ui/assets/app.css` and from the
 * `topbar()` function in `ui/assets/app.js`.
 *
 * Spec A.3 requires the top bar of **every** screen to name the runtime driver in force, which
 * is why the chip lives in the shell rather than on a page. The mockups declare the trail per
 * page in `window.PAGE.crumbs`; here it is derived from the pathname through the same navigation
 * table that drives the sidebar, so the two cannot disagree. A route the table does not name
 * renders no trail rather than a guess.
 */
import { usePathname } from 'next/navigation';

import { crumbsFor } from './navigation';

export interface RuntimeChip {
  /** What the chip says after "Runtime: ". */
  readonly label: string;
  /** The mockup's `.runtime-chip.warn` variant — amber, for a runtime that is not in good order. */
  readonly warn: boolean;
  /** Where the chip links, or `null` when the runtimes screen does not exist yet. */
  readonly href: string | null;
  /** Why the chip is amber, shown on hover. The chip is never dismissible, unlike the band. */
  readonly reason?: string;
}

const CHIP =
  'inline-flex min-w-0 max-w-full items-center justify-center gap-[7px] whitespace-normal rounded-[999px] border px-[9px] py-1 text-center text-[12px] leading-tight no-underline sm:whitespace-nowrap';

export function Topbar({ runtime }: { readonly runtime: RuntimeChip }) {
  const crumbs = crumbsFor(usePathname());

  return (
    <header className="sticky top-0 z-20 flex min-h-[52px] min-w-0 flex-col items-stretch gap-2 border-b border-border bg-bg px-4 py-2 sm:h-[52px] sm:flex-row sm:items-center sm:gap-3 sm:px-6 sm:py-0">
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-[7px] text-[13px] text-muted">
        {crumbs.map((crumb, index) => (
          <span key={crumb} className="flex items-center gap-[7px]">
            {index === 0 ? null : <span className="opacity-50">/</span>}
            {index === crumbs.length - 1 ? (
              <b className="font-semibold text-text">{crumb}</b>
            ) : (
              <span>{crumb}</span>
            )}
          </span>
        ))}
      </div>
      <div className="hidden flex-1 sm:block" />
      <RuntimeIndicator runtime={runtime} />
    </header>
  );
}

export function RuntimeIndicator({ runtime }: { readonly runtime: RuntimeChip }) {
  const tone = runtime.warn
    ? 'border-warn bg-warn-soft text-warn'
    : 'border-border-strong bg-surface text-text-2';
  const dot = `size-[7px] flex-none rounded-[50%] ${runtime.warn ? 'bg-warn' : 'bg-ok'}`;
  const title = runtime.reason ?? 'Runtime driver in force for this workspace';

  if (runtime.href === null) {
    return (
      <span className={`${CHIP} ${tone}`} title={title}>
        <span className={dot} />
        Runtime: {runtime.label}
      </span>
    );
  }
  return (
    <a className={`${CHIP} ${tone} hover:no-underline`} href={runtime.href} title={title}>
      <span className={dot} />
      Runtime: {runtime.label}
    </a>
  );
}
