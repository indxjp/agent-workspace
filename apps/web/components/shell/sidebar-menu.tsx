'use client';

/**
 * The sidebar's collapsible body on a narrow screen (UX-10 in #2086). Below `md` the sidebar sits
 * above the page, so a fully open menu pushed the chat box about 511px down a 390px-wide phone.
 * There the navigation is hidden behind a Menu button (the WAI-ARIA disclosure pattern:
 * `aria-expanded`, `aria-controls`, Esc closes and returns focus to the button). From `md` up the
 * button is not shown and the body is always visible, whatever the state says.
 *
 * The state records the pathname the menu was opened on, so following a link in it closes it
 * without an effect: on the next route `openOn` no longer matches.
 */
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

export function SidebarMenu({
  brand,
  children,
}: {
  /** The workspace row, shown beside the Menu button at every width. */
  readonly brand: ReactNode;
  /** The navigation and the identity foot, which the button shows and hides. */
  readonly children: ReactNode;
}) {
  const pathname = usePathname();
  // Boxed, so a `null` pathname (outside the App Router) never reads as "opened on this route".
  const [openOn, setOpenOn] = useState<{ readonly path: string | null } | null>(null);
  const open = openOn !== null && openOn.path === pathname;
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    setOpenOn(null);
    buttonRef.current?.focus();
  }

  return (
    <>
      <div className="flex items-stretch">
        <div className="min-w-0 flex-1">{brand}</div>
        <button
          ref={buttonRef}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            setOpenOn(open ? null : { path: pathname });
          }}
          onKeyDown={onKeyDown}
          className="flex flex-none items-center gap-1.5 border-b border-l border-border px-4 text-[13px] font-medium text-text-2 hover:bg-surface-3 hover:text-text focus:outline-2 focus:-outline-offset-2 focus:outline-accent md:hidden"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
            aria-hidden="true"
            className="size-[15px]"
          >
            {open ? <path d="M4 4l8 8M12 4l-8 8" /> : <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />}
          </svg>
          Menu
        </button>
      </div>
      <div
        id={panelId}
        onKeyDown={onKeyDown}
        className={`${open ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col border-b border-border md:flex md:border-b-0`}
      >
        {children}
      </div>
    </>
  );
}
