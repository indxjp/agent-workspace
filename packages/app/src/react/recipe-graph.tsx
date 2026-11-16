'use client';
/**
 * `RecipeGraph` and `RecipeRunList` (issue #1514): an app's recipes in the browser, read-only.
 *
 * - {@link RecipeGraph} draws one recipe run's steps in order, as a vertical list joined by
 *   connectors (never a canvas or an editor): each step's key, status, duration and cost, and a
 *   link to its run in the Agent Workspace console. A step waiting for approval shows the call it
 *   waits on with Approve and Reject, decided as the signed-in person through `recipeRoutes`. It
 *   asks for the run every 2 seconds until the run is stopped, and says what changed in a polite
 *   live region.
 * - {@link RecipeRunList} is the page of the workspace's recipe runs, newest first, each linking to
 *   its graph; a dashboard reuses it for "recipe progress".
 *
 * Both reach the routes through {@link recipeClient}, never a `fetch` of their own, and speak `ja`
 * and `en`. Both reflow to one column at 360 px: nothing is wider than its text.
 */
import type { RunApprovalDecision } from '@indx-workspace/contracts/runs';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type {
  RecipeRunDetail,
  RecipeRunPage,
  RecipeRunView,
  RecipeStepView,
} from '../recipe-wire.js';
import { ResourceProblemError } from './client.js';
import { useAppLocale } from './locale-context.js';
import { appStrings, problemMessage, type AppLocale, type AppStrings } from './locale.js';
import { recipeClient, type RecipeClient } from './recipe-client.js';
import {
  changeAnnouncement,
  formatCost,
  formatDuration,
  keepsPolling,
  orderedSteps,
  RECIPE_POLL_INTERVAL_MS,
  runBadge,
  stepBadge,
  stepDurationMs,
  type RecipeBadge,
} from './recipe-graph-model.js';

/** The props of {@link RecipeGraph}. */
export interface RecipeGraphProps {
  readonly recipeRunId: string;
  /** The run as the page's server read it; the graph asks for it first when not given. */
  readonly initial?: RecipeRunDetail | undefined;
  /** The recipe routes; `recipeClient()` on the page's own origin when not given. */
  readonly client?: RecipeClient | undefined;
  readonly locale?: AppLocale | undefined;
  /** How often to ask again while the run is not stopped; 2000 ms when not given. */
  readonly pollIntervalMs?: number | undefined;
}

/** What {@link RecipeGraphView} draws: the run, what changed, and how a decision is made. */
export interface RecipeGraphViewProps {
  readonly detail: RecipeRunDetail | null;
  readonly strings: AppStrings;
  readonly locale: AppLocale;
  /** The last change the live region says. */
  readonly announcement: string;
  /** The person-facing sentence of the last failure, or `null`. */
  readonly problem: string | null;
  /** The key of the step whose decision is being sent, or `null`. */
  readonly deciding: string | null;
  readonly onDecide: (stepKey: string, decision: RunApprovalDecision) => void;
}

function Badge({ badge }: { readonly badge: RecipeBadge }): ReactNode {
  return (
    <span className="aw-app-badge" data-tone={badge.tone}>
      {badge.label}
    </span>
  );
}

interface StepProps {
  /** The ids of the run's elements start with it, so two graphs on a page never share one. */
  readonly idPrefix: string;
  readonly step: RecipeStepView;
  readonly strings: AppStrings;
  readonly locale: AppLocale;
  readonly deciding: boolean;
  readonly busy: boolean;
  readonly onDecide: RecipeGraphViewProps['onDecide'];
}

/** The call a paused step waits on, with the person's two decisions. */
function StepApproval({ idPrefix, step, strings, deciding, busy, onDecide }: StepProps): ReactNode {
  const id = `${idPrefix}-${step.key}`;
  const words = strings.recipes;
  if (step.pendingApproval === null) return null;
  return (
    <div className="aw-app-recipe-approval" role="group" aria-labelledby={`${id}-call`}>
      <p id={`${id}-call`} className="aw-app-recipe-approval-heading">
        {words.pendingCall}
      </p>
      <p>
        {words.tool}: <code>{step.pendingApproval.toolName}</code>
      </p>
      <pre className="aw-app-recipe-call">
        <code>{step.pendingApproval.canonicalCall}</code>
      </pre>
      <div className="aw-app-recipe-actions">
        <button
          type="button"
          className="aw-app-button aw-app-primary"
          aria-label={words.approveLabel(step.key)}
          disabled={busy}
          onClick={() => {
            onDecide(step.key, 'approve');
          }}
        >
          {words.approve}
        </button>
        <button
          type="button"
          className="aw-app-button"
          aria-label={words.rejectLabel(step.key)}
          disabled={busy}
          onClick={() => {
            onDecide(step.key, 'reject');
          }}
        >
          {words.reject}
        </button>
      </div>
      {deciding ? <p className="aw-app-status">{words.deciding}</p> : null}
    </div>
  );
}

/** One step: its key and status, its facts, its run link, and its approval when it waits. */
function RecipeStep(props: StepProps): ReactNode {
  const { step, strings, locale } = props;
  const words = strings.recipes;
  // A running step's duration grows with the clock, which a server and a browser read apart.
  const duration =
    step.endedAt === null
      ? words.unknown
      : formatDuration(stepDurationMs(step, new Date(step.endedAt)), locale);
  return (
    <li className="aw-app-recipe-step" data-status={step.status}>
      <div className="aw-app-recipe-step-head">
        <h3 className="aw-app-recipe-step-key">{step.key}</h3>
        <Badge badge={stepBadge(step.status, words)} />
      </div>
      <dl className="aw-app-recipe-facts">
        <div>
          <dt>{words.duration}</dt>
          <dd>{duration}</dd>
        </div>
        <div>
          <dt>{words.cost}</dt>
          <dd>{step.cost === null ? words.unknown : formatCost(step.cost, locale)}</dd>
        </div>
      </dl>
      {step.error === null ? null : (
        <p className="aw-app-recipe-error">{words.failedWith(step.error)}</p>
      )}
      {step.runUrl === null ? null : (
        <a
          className="aw-app-recipe-run-link"
          href={step.runUrl}
          aria-label={words.openRunLabel(step.key)}
        >
          {words.openRun}
        </a>
      )}
      {step.status === 'awaiting_approval' ? <StepApproval {...props} /> : null}
    </li>
  );
}

/**
 * The graph as drawn from what {@link RecipeGraph} holds. It and its parts use no hook, so the
 * tests draw and press it without a browser; exported for them.
 */
export function RecipeGraphView(props: RecipeGraphViewProps): ReactNode {
  const { detail, strings, locale, announcement, problem, deciding, onDecide } = props;
  const id = `aw-recipe-${detail?.run.id ?? 'loading'}`;
  const words = strings.recipes;
  return (
    <section className="aw-app-recipe" aria-labelledby={`${id}-heading`}>
      <div className="aw-app-recipe-head">
        <h2 id={`${id}-heading`} className="aw-app-recipe-heading">
          {detail?.run.recipe ?? strings.loading}
        </h2>
        {detail === null ? null : <Badge badge={runBadge(detail.run.status, words)} />}
      </div>
      <p className="aw-app-status" role="status" aria-live="polite">
        {announcement}
      </p>
      {problem === null ? null : (
        <p className="aw-app-alert" role="alert">
          {problem}
        </p>
      )}
      {detail?.run.error == null ? null : (
        <p className="aw-app-recipe-error">{words.failedWith(detail.run.error)}</p>
      )}
      {detail === null ? null : (
        <ol className="aw-app-recipe-steps" aria-label={words.stepsLabel(detail.run.recipe)}>
          {detail.steps.length === 0 ? <li className="aw-app-empty">{words.noSteps}</li> : null}
          {orderedSteps(detail.steps).map((step) => (
            <RecipeStep
              key={step.key}
              idPrefix={id}
              step={step}
              strings={strings}
              locale={locale}
              deciding={deciding === step.key}
              busy={deciding !== null}
              onDecide={onDecide}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function problemOf(error: unknown, strings: AppStrings): string {
  return problemMessage(strings, error instanceof ResourceProblemError ? error.code : 'other');
}

/** A run that does not exist (or is not the person's): asking again would never change that. */
function isFinal(error: unknown): boolean {
  return error instanceof ResourceProblemError && [401, 404].includes(error.status);
}

/** A recipe run's steps, live until the run is stopped. */
export function RecipeGraph(props: RecipeGraphProps): ReactNode {
  const { recipeRunId, initial, pollIntervalMs = RECIPE_POLL_INTERVAL_MS } = props;
  const locale = useAppLocale(props.locale);
  const strings = appStrings(locale);
  const client = useMemo(() => props.client ?? recipeClient(), [props.client]);
  const [detail, setDetail] = useState<RecipeRunDetail | null>(initial ?? null);
  const [announcement, setAnnouncement] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [stopped, setStopped] = useState(false);
  const held = useRef<RecipeRunDetail | null>(initial ?? null);

  const apply = useCallback(
    (next: RecipeRunDetail) => {
      const said = changeAnnouncement(held.current, next, strings.recipes);
      held.current = next;
      setDetail(next);
      setProblem(null);
      if (said !== null) setAnnouncement(said);
    },
    [strings],
  );

  useEffect(() => {
    if (stopped || !keepsPolling(detail?.run ?? null)) return undefined;
    const abort = new AbortController();
    const timer = setTimeout(
      () => {
        client
          .get(recipeRunId, { signal: abort.signal })
          .then(apply)
          .catch((error: unknown) => {
            if (abort.signal.aborted) return;
            setProblem(problemOf(error, strings));
            if (isFinal(error)) setStopped(true);
            else setAttempt((count) => count + 1);
          });
      },
      detail === null && attempt === 0 ? 0 : pollIntervalMs,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [apply, attempt, client, detail, pollIntervalMs, recipeRunId, stopped, strings]);

  const onDecide = useCallback(
    (stepKey: string, decision: RunApprovalDecision) => {
      setDeciding(stepKey);
      setProblem(null);
      client
        .decide(recipeRunId, stepKey, decision)
        .then(apply)
        .catch((error: unknown) => {
          setProblem(problemOf(error, strings));
        })
        .finally(() => {
          setDeciding(null);
        });
    },
    [apply, client, recipeRunId, strings],
  );

  return (
    <RecipeGraphView
      detail={detail}
      strings={strings}
      locale={locale}
      announcement={announcement}
      problem={problem}
      deciding={deciding}
      onDecide={onDecide}
    />
  );
}

/** The props of {@link RecipeRunList}. */
export interface RecipeRunListProps {
  /** The first page as the page's server read it; the list asks for it when not given. */
  readonly initial?: RecipeRunPage | undefined;
  readonly client?: RecipeClient | undefined;
  readonly locale?: AppLocale | undefined;
  /** Only the runs of this recipe. */
  readonly recipe?: string | undefined;
  /** Where a run links to; `/recipes/<id>` when not given. */
  readonly runHref?: ((run: RecipeRunView) => string) | undefined;
}

/** When a run started, in the reader's language, in UTC so a server and a browser agree. */
function startedAt(run: RecipeRunView, locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(run.createdAt));
}

/** What {@link RecipeRunList} holds: the runs so far, the next cursor, and how loading goes. */
interface RunPages {
  readonly items: readonly RecipeRunView[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly problem: string | null;
}

/** The recipe runs of the workspace, newest first, each linking to its graph. */
export function RecipeRunList(props: RecipeRunListProps): ReactNode {
  const { initial, recipe, runHref } = props;
  const locale = useAppLocale(props.locale);
  const strings = appStrings(locale);
  const words = strings.recipes;
  const client = useMemo(() => props.client ?? recipeClient(), [props.client]);
  const [pages, setPages] = useState<RunPages>({
    items: initial?.items ?? [],
    nextCursor: initial?.nextCursor ?? null,
    loading: initial === undefined,
    problem: null,
  });

  const load = useCallback(
    (cursor: string | null) => {
      setPages((held) => ({ ...held, loading: true, problem: null }));
      client
        .list({ recipe, cursor })
        .then((page) => {
          setPages((held) => ({
            items: cursor === null ? page.items : [...held.items, ...page.items],
            nextCursor: page.nextCursor,
            loading: false,
            problem: null,
          }));
        })
        .catch((error: unknown) => {
          setPages((held) => ({ ...held, loading: false, problem: problemOf(error, strings) }));
        });
    },
    [client, recipe, strings],
  );

  useEffect(() => {
    if (initial === undefined) load(null);
  }, [initial, load]);

  const href = (run: RecipeRunView): string =>
    runHref?.(run) ?? `/recipes/${encodeURIComponent(run.id)}`;
  return (
    <div className="aw-app-list">
      <table className="aw-app-table">
        <caption className="aw-app-sr-only">{words.runsLabel}</caption>
        <thead>
          <tr>
            <th scope="col">{words.recipeColumn}</th>
            <th scope="col">{words.statusColumn}</th>
            <th scope="col">{words.startedColumn}</th>
          </tr>
        </thead>
        <tbody>
          {pages.items.length === 0 && !pages.loading ? (
            <tr>
              <td colSpan={3} className="aw-app-empty">
                {words.noRuns}
              </td>
            </tr>
          ) : null}
          {pages.items.map((run) => (
            <tr key={run.id}>
              <td>
                <a href={href(run)}>{run.recipe}</a>
              </td>
              <td>
                <Badge badge={runBadge(run.status, words)} />
              </td>
              <td>{startedAt(run, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="aw-app-pages">
        {pages.loading ? (
          <p className="aw-app-status" role="status">
            {strings.loading}
          </p>
        ) : null}
        {pages.problem === null ? null : (
          <p className="aw-app-alert" role="alert">
            {pages.problem}
          </p>
        )}
        {pages.nextCursor !== null && !pages.loading ? (
          <button
            type="button"
            className="aw-app-button"
            onClick={() => {
              load(pages.nextCursor);
            }}
          >
            {strings.loadMore}
          </button>
        ) : null}
      </div>
    </div>
  );
}
