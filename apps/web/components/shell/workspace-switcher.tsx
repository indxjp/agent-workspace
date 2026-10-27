'use client';

/**
 * The sidebar's workspace switcher — issue #120's Minimum implementation: "A keyboard- and
 * screen-reader-operable workspace switcher in the sidebar, listing exactly `GET /api/workspaces`
 * and switching through `POST /api/auth/workspace`. A switch performs a full navigation so no
 * tenant-scoped client cache survives it."
 *
 * ## Why switching is an HTML form, not a `fetch`
 *
 * Each workspace item is a real `<button type="submit" form="…">` bound — via the `form`
 * attribute, not by nesting — to the one hidden `<form method="post" action="/api/auth/workspace">`
 * this component renders once. Activating it is an ordinary form submission: the browser leaves
 * the current page, `POST /api/auth/workspace` re-reads the caller's memberships and mints a fresh
 * session (`apps/web/app/api/auth/workspace/route.ts`), and the response is a `303` back to `/`.
 * The submit handler conceals the current tenant document synchronously before navigation. The
 * next page is a fresh render under the new session, and a `pageshow.persisted` signal reloads a
 * document restored by Back under the current cookie before it can reveal its cached DOM. That
 * covers both transition-time exposure and the browser's one cache that can preserve a complete
 * document across a full navigation.
 *
 * ## Why the item that is already active is still a submit button
 *
 * A disabled "current" row would need its own focus and announcement rules and would still need a
 * route for "I clicked the one I'm already in" to do something sane. Submitting the current slug
 * again is a harmless no-op re-mint of the same session (`route.ts`'s `match` still succeeds), so
 * the current item stays live, marked with `aria-current="true"` and a "Current" label, rather than
 * becoming a second interaction pattern the menu has to teach.
 *
 * ## Why this polls `GET /api/workspaces` on every open, not once
 *
 * The list is small, membership changes are rare, and the one moment this list's accuracy matters
 * most — an administrator revoking the caller's own current membership while this tab stays open,
 * the card's own verifier attack — is exactly the moment a cached answer would be wrong. Re-fetching
 * on every open turns that stale-cache risk into the same "the server says so, and this screen
 * repeats it" honesty the rest of this task holds to. A failed re-read (`401`, or the `500
 * authorisation_undecidable` `vanished-membership.test.ts` documents for this exact race) is shown
 * as {@link WorkspacesProblem} with a route back to `/signin` — session re-verification, the
 * landed mechanism `POST /api/auth/workspace`'s own stale-selection branch already redirects there
 * for (`?error=session_expired`), never a second, invented one.
 */
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import {
  findCurrentMembership,
  type WorkspaceMembership,
  type WorkspacesProblem,
} from './workspaces-directory';
import {
  concealTenantDocument,
  shouldReloadRestoredTenantPage,
  WORKSPACE_DIRECTORY_CHANGED_EVENT,
} from './workspace-navigation';
import { browserClient } from '../../lib/browser-client';
import { loadWorkspaces } from './workspaces-requests-model';
import { DismissibleNotice } from './dismissible-notice';
import { recoverWorkspaceSession } from './session-recovery';
import { clampMenuIndex, nextMenuIndex, parseMenuKey } from './workspace-switcher-menu';

type LoadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly items: readonly WorkspaceMembership[] }
  | { readonly kind: 'problem'; readonly problem: WorkspacesProblem };

const ITEM_ROW =
  'flex w-full items-center gap-2 rounded-(--radius-sm) px-2.5 py-[7px] text-left text-[13px] no-underline focus:outline-2 focus:-outline-offset-1 focus:outline-accent';

/** The failed-request line, worded from the server's own `detail` where there is one — issue
 * #120's "every 403/409 is rendered as the server worded it" applies here too: a caller who lost
 * their current membership sees exactly what `/api/workspaces` said, not a generic "try again". */
function WorkspacesFailure({ problem }: Readonly<{ problem: WorkspacesProblem }>) {
  const message = problem.kind === 'api' ? problem.detail : problem.reason;
  return (
    <div role="alert" className="space-y-2 px-3 py-3 text-[12.5px] text-danger">
      <p className="m-0">{message}</p>
      <a href="/signin" className="font-medium text-accent underline">
        Sign in again
      </a>
    </div>
  );
}

export interface WorkspaceSwitcherProps {
  /** The session's own workspace slug — `apps/web/server/auth/session.ts`'s `ws` claim. */
  readonly currentSlug: string;
  readonly currentName: string;
  readonly currentDetail: string;
}

export function WorkspaceSwitcher({
  currentSlug,
  currentName,
  currentDetail,
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [activeIndex, setActiveIndex] = useState(0);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const menuId = useId();
  const formId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);

  const items = state.kind === 'loaded' ? state.items : [];
  const current = findCurrentMembership(items, currentSlug);
  // The roving-tabindex sequence is every workspace item plus the trailing "Manage workspaces…"
  // link — `+ 1` — so Arrow/Home/End keyboard navigation can reach it too, the same as any other
  // menu item, rather than leaving it a mouse-only dead end.
  const focusableCount = items.length + 1;

  useEffect(() => {
    let cancelled = false;

    function load() {
      // Keep an already-rendered menu stable while it is refreshed. Replacing its rows with a
      // loading paragraph would remove the focused menuitem from the DOM and drop focus onto the
      // document body — exactly the unannounced escape the keyboard acceptance attack forbids.
      setState((currentState) =>
        currentState.kind === 'idle' ? { kind: 'loading' } : currentState,
      );
      void loadWorkspaces(browserClient()).then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          const { problem } = result;
          if (
            recoverWorkspaceSession(problem, {
              clearTenantState: () => {
                setOpen(false);
                setState({ kind: 'idle' });
              },
              concealTenantDocument: () => concealTenantDocument(document),
              navigate: (path) => window.location.assign(path),
            })
          ) {
            return;
          }
          setState({ kind: 'problem', problem });
          return;
        }
        setState({ kind: 'loaded', items: result.value });
      });
    }

    // Always known on mount, so the archived banner below is accurate even before the menu is
    // ever opened, and re-read on every open — see this file's header for why.
    load();
    return () => {
      cancelled = true;
    };
  }, [open, refreshRevision]);

  useEffect(() => {
    function refreshDirectory() {
      setRefreshRevision((revision) => revision + 1);
    }
    window.addEventListener(WORKSPACE_DIRECTORY_CHANGED_EVENT, refreshDirectory);
    return () => window.removeEventListener(WORKSPACE_DIRECTORY_CHANGED_EVENT, refreshDirectory);
  }, []);

  useEffect(() => {
    function reloadRestoredPage(event: PageTransitionEvent) {
      if (shouldReloadRestoredTenantPage(event)) window.location.reload();
    }
    window.addEventListener('pageshow', reloadRestoredPage);
    return () => window.removeEventListener('pageshow', reloadRestoredPage);
  }, []);

  useEffect(() => {
    if (!open) return;
    setActiveIndex((index) => clampMenuIndex(index, focusableCount) ?? 0);
  }, [open, focusableCount]);

  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex, focusableCount]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      if (target instanceof Node && triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const key = parseMenuKey(event.key);
    if (key !== null) {
      event.preventDefault();
      const next = nextMenuIndex(activeIndex, key, focusableCount);
      if (next !== null) setActiveIndex(next);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'Tab') setOpen(false);
  }

  return (
    <div className="relative border-b border-border">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onTriggerKeyDown}
        className="flex w-full items-center gap-2.5 px-4 pt-4 pb-3.5 text-left focus:outline-2 focus:-outline-offset-2 focus:outline-accent"
      >
        <div className="grid size-[26px] flex-none place-items-center rounded-[7px] bg-text text-[13px] font-bold text-surface">
          {currentName.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <b className="block truncate text-[13px] font-semibold">{currentName}</b>
          <span className="block truncate text-[11.5px] text-muted">{currentDetail}</span>
        </div>
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className={`size-[13px] flex-none text-muted transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
        >
          <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
        </svg>
      </button>

      {current?.archivedAt != null ? (
        <DismissibleNotice
          id={`workspace-archived.${current.id}`}
          version={current.archivedAt}
          className="border-t border-warn bg-warn-soft px-4 py-2 text-[11.5px] text-warn"
        >
          This workspace is archived.{' '}
          <Link href="/workspaces" className="font-medium underline">
            Browse workspaces
          </Link>{' '}
          to switch or restore it.
        </DismissibleNotice>
      ) : null}

      {open ? (
        <div className="absolute inset-x-2 top-full z-30 mt-1 rounded-(--radius) border border-border bg-surface p-1.5 shadow-(--shadow)">
          <div
            id={menuId}
            ref={menuRef}
            role="menu"
            aria-label="Switch workspace"
            onKeyDown={onMenuKeyDown}
            className="max-h-[320px] overflow-y-auto"
          >
            {state.kind === 'loading' || state.kind === 'idle' ? (
              <p className="px-3 py-3 text-[12.5px] text-muted">Loading workspaces…</p>
            ) : null}
            {state.kind === 'problem' ? <WorkspacesFailure problem={state.problem} /> : null}
            {state.kind === 'loaded' && items.length === 0 ? (
              <p className="px-3 py-3 text-[12.5px] text-muted">
                You do not currently belong to any workspace.
              </p>
            ) : null}
            {state.kind === 'loaded'
              ? items.map((item, index) => (
                  <button
                    key={item.id}
                    ref={(element) => {
                      itemRefs.current[index] = element;
                    }}
                    type="submit"
                    form={formId}
                    name="workspace"
                    value={item.slug}
                    role="menuitem"
                    tabIndex={index === activeIndex ? 0 : -1}
                    aria-current={item.slug === currentSlug ? 'true' : undefined}
                    className={`${ITEM_ROW} ${item.slug === currentSlug ? 'bg-surface-3 font-semibold' : 'hover:bg-surface-3'}`}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    {item.archivedAt !== null ? (
                      <span className="flex-none rounded-[999px] bg-warn-soft px-1.5 py-px text-[10.5px] text-warn">
                        Archived
                      </span>
                    ) : null}
                    <span className="flex-none text-[11px] text-muted capitalize">{item.role}</span>
                    {item.slug === currentSlug ? (
                      <span className="flex-none text-[11px] text-accent">Current</span>
                    ) : null}
                  </button>
                ))
              : null}
            <div className="my-1 border-t border-border" />
            <Link
              href="/workspaces"
              role="menuitem"
              tabIndex={activeIndex === items.length ? 0 : -1}
              ref={(element) => {
                itemRefs.current[items.length] = element;
              }}
              className={`${ITEM_ROW} text-muted hover:bg-surface-3 hover:text-text`}
            >
              Manage workspaces…
            </Link>
          </div>
        </div>
      ) : null}

      {/* One shared, hidden form every item button submits through via its `form` attribute —
          not nested inside `role="menu"`, so the menu's only children are its menuitems. */}
      <form
        id={formId}
        method="post"
        action="/api/auth/workspace"
        className="hidden"
        onSubmit={() => concealTenantDocument(document)}
      />
    </div>
  );
}
