'use client';

/**
 * "Skip to content", the first thing Tab reaches on every shell screen (UX-23 in #2086). Each
 * screen draws its own `<main>` and none carries an id, so the link finds the landmark when it is
 * followed rather than naming an anchor; `tabIndex = -1` lets a non-interactive element take focus,
 * so the next Tab continues from the page and not from the sidebar.
 */
export function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only rounded-(--radius-sm) bg-surface px-3 py-2 text-[13px] font-semibold text-accent shadow-(--shadow-lg) focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
      onClick={(event) => {
        const main = document.querySelector('main');
        if (main === null) return;
        event.preventDefault();
        if (!main.hasAttribute('tabindex')) main.tabIndex = -1;
        main.focus();
      }}
    >
      Skip to content
    </a>
  );
}
