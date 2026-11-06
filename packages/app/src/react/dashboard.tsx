'use client';
/**
 * `Dashboard` (issue #1522): J5's "see what agents are doing", one page and four lists, no charts.
 *
 * 1. running now (`queued` and `running`);
 * 2. waiting for a decision (`awaiting_approval`, with the tool each waits on);
 * 3. failed in the last 24 hours;
 * 4. spend today, by currency. No spend ceiling is wired to the app kit yet, so the list says so;
 *    a ceiling column joins it when one is.
 *
 * Each list is a `<section>` with an `h2`, a table and an empty line. Each run's row links to its
 * run view in the Agent Workspace console, named "Open run <id>". The lists are the signed-in
 * person's, read by the app's `dashboardRoutes`, so a person never sees a run they could not open
 * in the console.
 *
 * It asks `GET /api/dashboard` every second while the page is visible, never two requests at once,
 * and pauses while it is hidden (`pollWhileVisible`). It speaks `ja` and `en` and reflows at
 * 360 px: each table scrolls inside its own section.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import type { DashboardSnapshot, DashboardSpend, RunSummary } from '../dashboard-wire.js';
import { ResourceProblemError } from './client.js';
import { dashboardClient, pollWhileVisible, type DashboardClient } from './dashboard-client.js';
import {
  byCurrency,
  DASHBOARD_POLL_INTERVAL_MS,
  formatSpend,
  relativeTime,
  runListsOf,
  runStatusBadge,
  runViewUrl,
  shortRunId,
  updatedAt,
  type DashboardRunList,
} from './dashboard-model.js';
import { useAppLocale } from './locale-context.js';
import { appStrings, problemMessage, type AppLocale, type DashboardStrings } from './locale.js';

/** The props of {@link Dashboard}. */
export interface DashboardProps {
  /** The Agent Workspace origin each row's run view is on: `${platformUrl}/runs?run=<id>`. */
  readonly platformUrl: string;
  /** Drawn after the four lists when given: the page's own recipe progress, such as `RecipeRunList`. */
  readonly recipeSteps?: ReactNode;
  /** An agent's name by its id; the id's first group when an agent is not named. */
  readonly agentNames?: Readonly<Record<string, string>> | undefined;
  /** The lists as the page's server read them; the dashboard asks for them first when not given. */
  readonly initial?: DashboardSnapshot | undefined;
  /** The dashboard route; `dashboardClient()` on the page's own origin when not given. */
  readonly client?: DashboardClient | undefined;
  readonly locale?: AppLocale | undefined;
  /** How often to ask again while visible; 1000 ms when not given. */
  readonly pollIntervalMs?: number | undefined;
}

/** What {@link DashboardView} draws. */
export interface DashboardViewProps {
  readonly platformUrl: string;
  readonly snapshot: DashboardSnapshot | null;
  readonly locale: AppLocale;
  /** The person-facing sentence of the last failure, or `null`. */
  readonly problem: string | null;
  readonly agentNames?: Readonly<Record<string, string>> | undefined;
  readonly recipeSteps?: ReactNode;
}

interface RowProps {
  readonly run: RunSummary;
  readonly list: DashboardRunList['key'];
  readonly asOf: string;
  readonly view: DashboardViewProps;
  readonly strings: DashboardStrings;
}

/** The run's link to its console view, and the lead run of a team member's run. */
function RunCell({ run, view, strings }: RowProps): ReactNode {
  return (
    <td>
      <a href={runViewUrl(view.platformUrl, run.id)} aria-label={strings.openRunLabel(run.id)}>
        <code>{shortRunId(run.id)}</code>
      </a>
      {run.parentRunId === null ? null : (
        <span className="aw-app-dashboard-lead">
          {strings.partOfRun(shortRunId(run.parentRunId))}
        </span>
      )}
    </td>
  );
}

/** The cell a list has of its own: the status, the tool waited on, or the error. */
function ListCell({ run, list, strings }: RowProps): ReactNode {
  if (list === 'waiting')
    return <td>{run.pendingApproval?.toolName ?? strings.runStatus[run.status]}</td>;
  if (list === 'failed')
    return <td className="aw-app-recipe-error">{run.error ?? strings.runStatus.failed}</td>;
  const badge = runStatusBadge(run.status, strings);
  return (
    <td>
      <span className="aw-app-badge" data-tone={badge.tone}>
        {badge.label}
      </span>
    </td>
  );
}

function RunRow(props: RowProps): ReactNode {
  const { run, asOf, view } = props;
  return (
    <tr>
      <RunCell {...props} />
      <td>{view.agentNames?.[run.agentId] ?? shortRunId(run.agentId)}</td>
      <ListCell {...props} />
      <td>
        <time dateTime={run.createdAt}>{relativeTime(run.createdAt, asOf, view.locale)}</time>
      </td>
    </tr>
  );
}

/** The column of a list that differs: status, the tool waited on, or the error. */
function listColumn(list: DashboardRunList['key'], strings: DashboardStrings): string {
  if (list === 'waiting') return strings.waitingOnColumn;
  if (list === 'failed') return strings.errorColumn;
  return strings.statusColumn;
}

function RunSection(props: {
  readonly list: DashboardRunList;
  readonly asOf: string;
  readonly view: DashboardViewProps;
  readonly strings: DashboardStrings;
}): ReactNode {
  const { list, asOf, view, strings } = props;
  const id = `aw-dashboard-${list.key}`;
  return (
    <section className="aw-app-dashboard-section" aria-labelledby={id} data-list={list.key}>
      <h2 id={id}>{list.heading}</h2>
      <div className="aw-app-dashboard-frame">
        <table className="aw-app-table">
          <thead>
            <tr>
              <th scope="col">{strings.runColumn}</th>
              <th scope="col">{strings.agentColumn}</th>
              <th scope="col">{listColumn(list.key, strings)}</th>
              <th scope="col">{strings.startedColumn}</th>
            </tr>
          </thead>
          <tbody>
            {list.rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="aw-app-empty">
                  {list.empty}
                </td>
              </tr>
            ) : null}
            {list.rows.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                list={list.key}
                asOf={asOf}
                view={view}
                strings={strings}
              />
            ))}
          </tbody>
        </table>
      </div>
      {list.truncated ? <p className="aw-app-status">{strings.truncated}</p> : null}
    </section>
  );
}

function SpendSection(props: {
  readonly spend: readonly DashboardSpend[];
  readonly truncated: boolean;
  readonly locale: AppLocale;
  readonly strings: DashboardStrings;
}): ReactNode {
  const { spend, truncated, locale, strings } = props;
  const id = 'aw-dashboard-spend';
  return (
    <section className="aw-app-dashboard-section" aria-labelledby={id} data-list="spend">
      <h2 id={id}>{strings.spendHeading}</h2>
      <div className="aw-app-dashboard-frame">
        <table className="aw-app-table">
          <thead>
            <tr>
              <th scope="col">{strings.currencyColumn}</th>
              <th scope="col">{strings.amountColumn}</th>
              <th scope="col">{strings.runsColumn}</th>
              <th scope="col">{strings.unsettledColumn}</th>
            </tr>
          </thead>
          <tbody>
            {spend.length === 0 ? (
              <tr>
                <td colSpan={4} className="aw-app-empty">
                  {strings.noSpend}
                </td>
              </tr>
            ) : null}
            {byCurrency(spend).map((row) => (
              <tr key={row.currency}>
                <td>{row.currency}</td>
                <td data-cell="number">{formatSpend(row, locale)}</td>
                <td data-cell="number">{row.runs}</td>
                <td data-cell="number">{row.unsettled}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="aw-app-status">{strings.noCeiling}</p>
      {truncated ? <p className="aw-app-status">{strings.truncated}</p> : null}
    </section>
  );
}

/**
 * The four lists as drawn from what {@link Dashboard} holds. It uses no hook, so the tests draw it
 * without a browser; exported for them.
 */
export function DashboardView(view: DashboardViewProps): ReactNode {
  const strings = appStrings(view.locale);
  const words = strings.dashboard;
  const { snapshot } = view;
  return (
    <div className="aw-app-dashboard">
      {view.problem === null ? null : (
        <p className="aw-app-alert" role="alert">
          {view.problem}
        </p>
      )}
      {snapshot === null ? (
        <p className="aw-app-status" role="status">
          {strings.loading}
        </p>
      ) : (
        <>
          <p className="aw-app-status">
            <time dateTime={snapshot.asOf}>
              {words.updatedAt(updatedAt(snapshot.asOf, view.locale))}
            </time>
          </p>
          {runListsOf(snapshot, words).map((list) => (
            <RunSection
              key={list.key}
              list={list}
              asOf={snapshot.asOf}
              view={view}
              strings={words}
            />
          ))}
          <SpendSection
            spend={snapshot.spendToday}
            truncated={snapshot.truncated.spend}
            locale={view.locale}
            strings={words}
          />
        </>
      )}
      {view.recipeSteps ?? null}
    </div>
  );
}

/** A refusal asking again would never change: the person is not signed in, or the route is gone. */
function isFinal(error: unknown): boolean {
  return error instanceof ResourceProblemError && [401, 404].includes(error.status);
}

/** J5's four lists, live while the page is visible. */
export function Dashboard(props: DashboardProps): ReactNode {
  const { platformUrl, initial, pollIntervalMs = DASHBOARD_POLL_INTERVAL_MS } = props;
  const locale = useAppLocale(props.locale);
  const client = useMemo(() => props.client ?? dashboardClient(), [props.client]);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(initial ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const hasInitial = initial !== undefined;

  useEffect(() => {
    const strings = appStrings(locale);
    const stop = pollWhileVisible({
      intervalMs: pollIntervalMs,
      firstDelayMs: hasInitial ? pollIntervalMs : 0,
      visibility: globalThis.document,
      tick: async (signal) => {
        try {
          const next = await client.get({ signal });
          setSnapshot(next);
          setProblem(null);
        } catch (error) {
          if (signal.aborted) return;
          const code = error instanceof ResourceProblemError ? error.code : 'other';
          setProblem(problemMessage(strings, code));
          if (isFinal(error)) stop();
        }
      },
    });
    return stop;
  }, [client, hasInitial, locale, pollIntervalMs]);

  return (
    <DashboardView
      platformUrl={platformUrl}
      snapshot={snapshot}
      locale={locale}
      problem={problem}
      agentNames={props.agentNames}
      recipeSteps={props.recipeSteps}
    />
  );
}
