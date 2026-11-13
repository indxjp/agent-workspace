'use client';

/**
 * `/runs` — durable run history and usage/cost detail, issue #136 (W9-UI-136).
 *
 * This is the whole reason `#136` exists: `GET /api/runs` (issue #135) is a real, workspace-scoped,
 * database-backed history, and this screen renders exactly what it answers — nothing from
 * the process-local, incomplete-by-construction telemetry projection (`#116` scoped it as
 * operational-only) and nothing from a fallback when the durable fetch fails. A failure is shown
 * as a failure.
 *
 * ## What this screen renders for which role, and why there is no role table here
 *
 * `apps/web/server/runs/api.ts`'s own header explains the current policy: an Owner's and an
 * Admin's grant is `any` (workspace-wide), and a Builder's and a Viewer's is `own`. Admin was `own`
 * too until issue `#165` — the mismatch with issue #135's "Owner/Admin see allowed workspace
 * history" reading of spec §21 that
 * `docs/adr/W9-PLAN-the-run-list-card-assumed-an-admin-grant-the-policy-does-not-give.md` recorded,
 * and which `docs/adr/W9-AUTH-165-admin-reads-workspace-run-history.md` resolved by widening that
 * one policy cell. This screen does not encode that policy anywhere: it renders whatever
 * page `GET /api/runs` answers for the signed-in caller, and shows the `user` filter control only
 * once a real request has confirmed the server accepts it (`probeUserFilter` in
 * `./run-requests-model.ts`) — never by checking `role` against a table this file would have to keep in sync
 * with `permissions.ts` by hand. `#165` widened the server's grant and this screen widened with it,
 * needing no change — which is the point this paragraph is making.
 *
 * ## Filters, pagination and the selected run all live in the URL
 *
 * `?status=&agent=&project=&user=&cursor=` filter and page the list; `?run=<id>` switches this same
 * route to the detail panel (`./run-detail-panel.tsx` —
 * `docs/adr/W9-PLAN-run-detail-is-a-panel-not-a-new-screen.md`: no new route, no new mockup). Every
 * link this screen draws is built from the *current* `URLSearchParams` with one field changed
 * (`withScreenState`), so following one never drops the others — the task card's own "a view is
 * linkable".
 *
 * ## Agent, project, user and workspace names are resolved from catalogues this screen already has
 * read access to
 *
 * `GET /api/runs` renders ids, not names (`agentId`, `projectId`, `initiatingUserId`,
 * `workspaceId`) — the same shape `GET /api/runs/:id` has always used. Names come from
 * `GET /api/agents`, `GET /api/projects`, `GET /api/users` and `GET /api/workspaces`, fetched once
 * here and shared by the list and the detail panel. `GET /api/agents` grants every role `read:
 * 'any'` (`permissions.ts`), so agent-name resolution is complete for every caller; `GET /api/projects`
 * narrows a Builder/Viewer's *visible* projects to their own (`server/projects/http.ts`'s `GET`
 * handler), so for those two roles a project id absent from the fetched catalogue is reported as
 * `'deleted'` even though it may only be a project this caller cannot see — a declared narrowing
 * (see this task's PR), not a claim this screen has verified. Owner and Admin see every project, so
 * the distinction is exact for them.
 *
 * The active workspace is not repeated here: `apps/web/app/(shell)/layout.tsx` already names it in
 * the persistent sidebar on every screen, `GET /api/runs` never returns more than one
 * `workspaceId` per response (the caller's own), and no API this wave ships lets a client ask
 * "which of my memberships is the active one" — that is `#119`/`#120`'s surface, not `#135`'s. The
 * detail panel still resolves and shows a run's `workspaceId` against `GET /api/workspaces`
 * (`./run-detail-panel.tsx`), which is the per-run tenant-boundary fact the task card actually asks
 * for.
 */
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { browserClient } from '../../lib/browser-client';
import { ProblemDetail } from '../agents/problem-line';
import type { VersionsLocale } from '../agents/versions-messages';
import { RunDetailPanel } from './run-detail-panel';
import { runStatusLabel } from './run-view-messages';
import { runsStrings, type RunsStrings } from './runs-messages';
import { loadCatalog, loadRunPage, probeUserFilter } from './run-requests-model';
import { StatusBadge } from './run-view';
import {
  RUN_STATUS_NAMES,
  RUN_POLL_INTERVAL_MS,
  badgeForRunStatus,
  cursorFromSearchParams,
  filtersFromSearchParams,
  formatDuration,
  formatProviderModel,
  formatCostDisplay,
  formatTimestamp,
  formatTokenCount,
  resolveResourceReference,
  runMatchesSearch,
  runIdFromSearchParams,
  shouldPollDurableRun,
  timestampAccessibilityLabel,
  withScreenState,
  type CatalogKind,
  type CatalogState,
  type RequestProblem,
  type RunListFilters,
  type RunListItem,
  type UserFilterAvailability,
} from './history';

const CARD = 'rounded-(--radius) border border-border bg-surface shadow-(--shadow)';
const CALLOUT_DANGER =
  'flex items-start gap-[11px] rounded-(--radius) border border-danger bg-danger-soft p-[14px] text-[13px] text-danger';
const CONTROL =
  'h-8 rounded-(--radius-sm) border border-border-strong bg-surface px-2.5 text-[13px] text-text focus:border-accent focus:outline-2 focus:-outline-offset-1 focus:outline-accent';
const BTN =
  'inline-flex h-8 items-center justify-center gap-[7px] whitespace-nowrap rounded-(--radius-sm) border px-[13px] text-[13px] font-medium no-underline';
const BTN_DEFAULT = 'border-border-strong bg-surface text-text';

// ── Loading one workspace catalogue ─────────────────────────────────────────────────────────────

/** Fetch a `GET` list endpoint into a {@link CatalogState}. Never throws — a failure is `'unavailable'`. */
function useCatalog(kind: CatalogKind): CatalogState {
  const [state, setState] = useState<CatalogState>({ kind: 'loading' });
  useEffect(() => {
    let cancelled = false;
    loadCatalog(browserClient(), kind).then(
      (catalog) => {
        if (!cancelled) setState({ kind: 'ready', catalog });
      },
      () => {
        if (!cancelled) setState({ kind: 'unavailable' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [kind]);
  return state;
}

/** Probe whether the signed-in caller may use the `user` filter — see `./history.ts`'s header. */
function useUserFilterAvailability(): UserFilterAvailability | null {
  const [state, setState] = useState<UserFilterAvailability | null>(null);
  useEffect(() => {
    let cancelled = false;
    void probeUserFilter(browserClient()).then((availability) => {
      if (!cancelled) setState(availability);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

// ── The screen ───────────────────────────────────────────────────────────────────────────────────

export function RunsHistoryScreen({
  locale = 'en',
}: Readonly<{
  /** The reader's language (UX-15 in #2086); the page negotiates it from `Accept-Language`. */
  locale?: VersionsLocale;
}>) {
  const strings = runsStrings(locale);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const agents = useCatalog('agents');
  // `loadCatalog` asks for archived projects too (issue #184); the role narrowing is unchanged.
  const projects = useCatalog('projects');
  const users = useCatalog('users');
  const workspaces = useCatalog('workspaces');
  const userFilterAvailability = useUserFilterAvailability();

  const runId = runIdFromSearchParams(searchParams);

  return (
    <main lang={locale} className="w-full max-w-[1120px] px-4 pt-[26px] pb-[90px] sm:px-8">
      <div className="mb-5">
        <h1 className="text-[21px]">{strings.title}</h1>
        <p className="text-[13px] text-muted">{strings.intro}</p>
      </div>

      {runId === null ? (
        <RunsListView
          pathname={pathname}
          searchParams={searchParams}
          catalogs={{ agents, projects, users, workspaces }}
          userFilterAvailability={userFilterAvailability}
          locale={locale}
        />
      ) : (
        <RunDetailPanel
          runId={runId}
          backHref={`${pathname}?${withScreenState(searchParams, { run: null }).toString()}`}
          catalogs={{ agents, projects, users, workspaces }}
          locale={locale}
        />
      )}
    </main>
  );
}

// ── The list ─────────────────────────────────────────────────────────────────────────────────────

interface Catalogs {
  readonly agents: CatalogState;
  readonly projects: CatalogState;
  readonly users: CatalogState;
  readonly workspaces: CatalogState;
}

type ListLoad =
  | { readonly kind: 'loading' }
  | { readonly kind: 'problem'; readonly problem: RequestProblem }
  | {
      readonly kind: 'loaded';
      readonly runs: readonly RunListItem[];
      readonly nextCursor: string | null;
    };

function catalogOptions(
  catalog: CatalogState,
): readonly { readonly id: string; readonly label: string }[] {
  if (catalog.kind !== 'ready') return [];
  return [...catalog.catalog.byId.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function RunsListView({
  pathname,
  searchParams,
  catalogs,
  userFilterAvailability,
  locale,
}: Readonly<{
  pathname: string;
  searchParams: URLSearchParams;
  catalogs: Catalogs;
  userFilterAvailability: UserFilterAvailability | null;
  locale: VersionsLocale;
}>) {
  const strings = runsStrings(locale);
  const router = useRouter();
  const filters = filtersFromSearchParams(searchParams);
  const cursor = cursorFromSearchParams(searchParams);
  const [state, setState] = useState<ListLoad>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setState({ kind: 'loading' });

    async function load(): Promise<void> {
      const outcome = await loadRunPage(browserClient(), filters, cursor);
      if (cancelled) return;
      if (!outcome.ok) {
        setState({ kind: 'problem', problem: outcome.problem });
        return;
      }
      const page = outcome.value;
      // A poll replaces the complete page. No live estimate is added to durable ledger totals.
      setState({ kind: 'loaded', runs: page.runs, nextCursor: page.nextCursor });
      if (page.runs.some(shouldPollDurableRun)) {
        timer = setTimeout(() => {
          void load();
        }, RUN_POLL_INTERVAL_MS);
      }
    }

    void load();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [filters.status, filters.agentId, filters.projectId, filters.userId, cursor]);

  function navigate(patch: Parameters<typeof withScreenState>[1]): void {
    router.push(`${pathname}?${withScreenState(searchParams, patch).toString()}`);
  }

  const visibleRuns =
    state.kind === 'loaded'
      ? state.runs.filter((run) => {
          const references = [
            resolveResourceReference(run.agentId, catalogs.agents),
            resolveResourceReference(run.projectId, catalogs.projects),
            resolveResourceReference(run.initiatingUserId, catalogs.users),
            resolveResourceReference(run.workspaceId, catalogs.workspaces),
          ];
          return runMatchesSearch(
            run,
            filters.query,
            references.flatMap((reference) =>
              reference.kind === 'resolved' ? [reference.label] : [],
            ),
          );
        })
      : [];

  return (
    <div>
      <FilterBar
        filters={filters}
        agentOptions={catalogOptions(catalogs.agents)}
        projectOptions={catalogOptions(catalogs.projects)}
        userOptions={catalogOptions(catalogs.users)}
        showUserFilter={userFilterAvailability === 'available'}
        strings={strings}
        locale={locale}
        onChange={(patch) => {
          navigate({ ...patch, cursor: null });
        }}
      />

      {state.kind === 'loading' ? (
        <p className="mt-4 text-[13px] text-muted">{strings.loadingRuns}</p>
      ) : null}

      {state.kind === 'problem' ? (
        <div className={`mt-4 ${CALLOUT_DANGER}`} role="alert">
          <span aria-hidden="true" className="flex-none text-[14px] leading-[1.4]">
            !
          </span>
          <div className="min-w-0 flex-1">
            <ProblemDetail locale={locale} lead={strings.runsLoadFailed} problem={state.problem} />
          </div>
        </div>
      ) : null}

      {state.kind === 'loaded' && state.runs.length === 0 ? (
        <p className="mt-4 text-[13px] text-muted">{strings.noRuns}</p>
      ) : null}

      {state.kind === 'loaded' && state.runs.length > 0 && visibleRuns.length === 0 ? (
        <p className="mt-4 text-[13px] text-muted">{strings.noSearchMatch}</p>
      ) : null}

      {state.kind === 'loaded' && visibleRuns.length > 0 ? (
        <div className={`mt-4 ${CARD}`}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  {[...strings.columns, ''].map((heading) => (
                    <th
                      key={heading}
                      className="border-b border-border bg-surface-2 px-4 py-[9px] text-left text-[11.5px] font-semibold tracking-[.04em] whitespace-nowrap text-muted uppercase"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRuns.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    catalogs={catalogs}
                    openHref={`${pathname}?${withScreenState(searchParams, { run: run.id }).toString()}`}
                    strings={strings}
                    locale={locale}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {state.kind === 'loaded' && state.nextCursor !== null ? (
        <div className="mt-4">
          <Link
            href={`${pathname}?${withScreenState(searchParams, { cursor: state.nextCursor }).toString()}`}
            className={`${BTN} ${BTN_DEFAULT}`}
          >
            {strings.nextPage}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function RunRow({
  run,
  catalogs,
  openHref,
  strings,
  locale,
}: Readonly<{
  run: RunListItem;
  catalogs: Catalogs;
  openHref: string;
  strings: RunsStrings;
  locale: VersionsLocale;
}>) {
  const agent = resolveResourceReference(run.agentId, catalogs.agents);
  const user = resolveResourceReference(run.initiatingUserId, catalogs.users);
  return (
    <tr className="hover:bg-surface-2">
      <td className="border-b border-border px-4 py-[11px] align-middle whitespace-nowrap">
        <ExactTimestamp iso={run.createdAt} />
      </td>
      <td className="border-b border-border px-4 py-[11px] align-middle">
        {agent.kind === 'resolved' ? (
          <Link href={`/agents/${agent.id}`} className="text-accent no-underline hover:underline">
            {agent.label}
          </Link>
        ) : agent.kind === 'deleted' ? (
          <span className="text-muted">{strings.deletedAgent}</span>
        ) : (
          <span className="text-muted">{strings.notAvailable}</span>
        )}
      </td>
      <td className="border-b border-border px-4 py-[11px] align-middle">
        <StatusBadge badge={badgeForRunStatus(run.status)} locale={locale} />
      </td>
      <td className="border-b border-border px-4 py-[11px] align-middle">
        {user.kind === 'resolved' ? (
          user.label
        ) : user.kind === 'absent' ? (
          <span className="text-muted">—</span>
        ) : user.kind === 'deleted' ? (
          <span className="text-muted">{strings.noLongerMember}</span>
        ) : (
          <span className="text-muted">{strings.notAvailable}</span>
        )}
      </td>
      <td className="border-b border-border px-4 py-[11px] align-middle">
        {formatProviderModel(run.provider, run.model, strings)}
      </td>
      <td className="border-b border-border px-4 py-[11px] align-middle whitespace-nowrap">
        {formatDuration(run.durationMs, run.status, strings)}
      </td>
      <td className="border-b border-border px-4 py-[11px] align-middle whitespace-nowrap">
        {formatTokenCount(run.usage.totalTokens)}
      </td>
      <td className="border-b border-border px-4 py-[11px] align-middle whitespace-nowrap">
        {formatCostDisplay(run, strings)}
      </td>
      <td className="border-b border-border px-4 py-[11px] align-middle">
        <Link
          href={openHref}
          className={`${BTN} ${BTN_DEFAULT}`}
          aria-label={strings.openRunLabel(run.id)}
        >
          {strings.open}
        </Link>
      </td>
    </tr>
  );
}

function FilterBar({
  filters,
  agentOptions,
  projectOptions,
  userOptions,
  showUserFilter,
  strings,
  locale,
  onChange,
}: Readonly<{
  strings: RunsStrings;
  locale: VersionsLocale;
  filters: RunListFilters;
  agentOptions: readonly { readonly id: string; readonly label: string }[];
  projectOptions: readonly { readonly id: string; readonly label: string }[];
  userOptions: readonly { readonly id: string; readonly label: string }[];
  showUserFilter: boolean;
  onChange: (patch: {
    query?: string | null;
    status?: string | null;
    agentId?: string | null;
    projectId?: string | null;
    userId?: string | null;
  }) => void;
}>) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-[13px]">
        <span className="mb-1 block text-[11.5px] font-semibold tracking-[.04em] text-muted uppercase">
          {strings.searchThisPage}
        </span>
        <input
          className={`${CONTROL} w-48`}
          type="search"
          value={filters.query ?? ''}
          placeholder={strings.searchPlaceholder}
          onChange={(event) => {
            onChange({ query: event.target.value === '' ? null : event.target.value });
          }}
        />
      </label>

      <label className="text-[13px]">
        <span className="mb-1 block text-[11.5px] font-semibold tracking-[.04em] text-muted uppercase">
          {strings.status}
        </span>
        <select
          className={CONTROL}
          value={filters.status ?? ''}
          onChange={(event) => {
            onChange({ status: event.target.value === '' ? null : event.target.value });
          }}
        >
          <option value="">{strings.allStatuses}</option>
          {RUN_STATUS_NAMES.map((status) => (
            <option key={status} value={status}>
              {/* English keeps the status's own name; Japanese reads as the badge does. */}
              {locale === 'en' ? status : runStatusLabel(badgeForRunStatus(status).label, locale)}
            </option>
          ))}
        </select>
      </label>

      <label className="text-[13px]">
        <span className="mb-1 block text-[11.5px] font-semibold tracking-[.04em] text-muted uppercase">
          {strings.agent}
        </span>
        <select
          className={CONTROL}
          value={filters.agentId ?? ''}
          onChange={(event) => {
            onChange({ agentId: event.target.value === '' ? null : event.target.value });
          }}
        >
          <option value="">{strings.allAgents}</option>
          {agentOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="text-[13px]">
        <span className="mb-1 block text-[11.5px] font-semibold tracking-[.04em] text-muted uppercase">
          {strings.project}
        </span>
        <select
          className={CONTROL}
          value={filters.projectId ?? ''}
          onChange={(event) => {
            onChange({ projectId: event.target.value === '' ? null : event.target.value });
          }}
        >
          <option value="">{strings.allProjects}</option>
          {projectOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {showUserFilter ? (
        <label className="text-[13px]">
          <span className="mb-1 block text-[11.5px] font-semibold tracking-[.04em] text-muted uppercase">
            {strings.startedBy}
          </span>
          <select
            className={CONTROL}
            value={filters.userId ?? ''}
            onChange={(event) => {
              onChange({ userId: event.target.value === '' ? null : event.target.value });
            }}
          >
            <option value="">{strings.everyone}</option>
            {userOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {filters.query === undefined &&
      filters.status === undefined &&
      filters.agentId === undefined &&
      filters.projectId === undefined &&
      filters.userId === undefined ? null : (
        <button
          type="button"
          className={`${BTN} ${BTN_DEFAULT}`}
          onClick={() => {
            onChange({ query: null, status: null, agentId: null, projectId: null, userId: null });
          }}
        >
          {strings.clearFilters}
        </button>
      )}
    </div>
  );
}

function ExactTimestamp({ iso }: Readonly<{ iso: string }>) {
  return (
    <time dateTime={iso} title={iso} aria-label={timestampAccessibilityLabel(iso)}>
      {formatTimestamp(iso)}
    </time>
  );
}
