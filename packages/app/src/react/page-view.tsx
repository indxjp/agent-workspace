'use client';
/**
 * `PageView`: one page of a `definePages` resource (issue #1521): its title and body in
 * `RichText`, Save with the `expectedRevisionId` the person read, a revisions drawer, and the
 * agent actions "Rewrite with <agent>" and "Summarize into new page".
 *
 * A save refused `409 page_conflict` offers "Load latest" (the person's edits are dropped) or
 * "Keep mine" (saved again on top of the latest revision); it never merges. The drawer lists each
 * revision newest first, with who saved it, an agent badge and a link to the run when an agent
 * saved it, a preview drawn by `AssistantProse`, and Restore, which saves it as a new revision.
 *
 * An action opens the `AgentPanel` beside the page with a prompt naming the page, its tool and
 * the revision (`page-actions.ts`); the person sends it. The agent writes as the person, through
 * the page's agent tools, so its change lands as a new revision carrying its run, and the view
 * loads it when the run completes. While the person has unsaved edits the view does not replace
 * them: it says the page changed and offers the same two choices.
 */
import { AssistantProse } from '@indx-workspace/react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

import type { PageRecord, PageRevision } from '../db/page-port.js';
import type { RichTextBlock } from '../fields/rich-text.js';
import { blocksToMarkdown } from '../pages/blocks.js';
import { PAGE_TITLE_MAX, type DefinedPages } from '../pages/define-pages.js';
import type { FieldMap } from '../resource.js';
import type { AgentPanelClient } from './agent-panel-client.js';
import {
  AgentPanel,
  type AgentPanelAgent,
  type AgentPanelCompletion,
  type AgentPanelProps,
} from './agent-panel.js';
import { ResourceProblemError } from './client.js';
import { runViewUrl, shortRunId } from './dashboard-model.js';
import { useAppLocale } from './locale-context.js';
import { appStrings, problemMessage, type AppLocale, type PageStrings } from './locale.js';
import { rewritePrompt, summarizePrompt } from './page-actions.js';
import { pageClient, type PageClient } from './page-client.js';
import { RichText } from './rich-text.js';

/** The most pages under it a summary prompt names, so the prompt stays within the run's limit. */
const SUMMARY_CHILDREN_MAX = 50;

/** The props of {@link PageView}. */
export interface PageViewProps<F extends FieldMap = FieldMap> {
  readonly resource: DefinedPages<F>;
  readonly id: string;
  /** The agents the actions and the panel offer; no actions and no panel when none. */
  readonly agents?: readonly AgentPanelAgent[] | undefined;
  /** The Agent Workspace origin a revision's run link opens on: `${platformUrl}/runs?run=<id>`. */
  readonly platformUrl?: string | undefined;
  /** The name of the person a principal id is; the id's first group when not given. */
  readonly personName?: ((principalId: string) => string | undefined) | undefined;
  /** Called with the page after a save, a restore, or an agent's change was loaded. */
  readonly onChanged?: ((page: PageRecord<F>) => void) | undefined;
  /** Passed to the agent panel. */
  readonly renderApproval?: AgentPanelProps['renderApproval'];
  /** The language of the view's words; the `AppTheme`'s when not given, `en` outside one. */
  readonly locale?: AppLocale | undefined;
  /** The client of the pages' routes; one for the page's own origin when not given. */
  readonly client?: PageClient<F> | undefined;
  /** The agent panel's client; one for the page's own origin when not given. */
  readonly panelClient?: AgentPanelClient | undefined;
}

function codeOf(error: unknown): string {
  return error instanceof ResourceProblemError ? error.code : 'other';
}

function titleOf(page: PageRecord): string {
  return String(page['title']);
}

function blocksOf(page: PageRecord): readonly RichTextBlock[] {
  return page['blocks'] as readonly RichTextBlock[];
}

/** When a revision was saved, in UTC, so a server and a browser draw the same words. */
function revisionTime(at: string, locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(at));
}

/** Why the page offers the two choices: a refused save, or an agent's change under unsaved edits. */
export type PageConflictReason = 'conflict' | 'agent';

/** The conflict notice and its two choices. Exported for the view's tests. */
export function PageConflictNotice({
  reason,
  strings,
  pending,
  onLoadLatest,
  onKeepMine,
}: {
  readonly reason: PageConflictReason;
  readonly strings: PageStrings;
  readonly pending: boolean;
  readonly onLoadLatest: () => void;
  readonly onKeepMine: () => void;
}): ReactNode {
  return (
    <div className="aw-app-alert" role="alert">
      <p className="aw-app-alert-heading">{strings.conflictHeading}</p>
      <p>{reason === 'agent' ? strings.agentChangedBody : strings.conflictBody}</p>
      <div className="aw-app-actions">
        <button type="button" className="aw-app-button" disabled={pending} onClick={onLoadLatest}>
          {strings.loadLatest}
        </button>
        <button
          type="button"
          className="aw-app-button aw-app-primary"
          disabled={pending}
          onClick={onKeepMine}
        >
          {strings.keepMine}
        </button>
      </div>
    </div>
  );
}

/** What the revision list draws each entry with. */
export interface PageRevisionListProps {
  readonly revisions: readonly PageRevision[];
  readonly currentRevisionId: string | null;
  readonly strings: PageStrings;
  readonly locale: AppLocale;
  readonly platformUrl?: string | undefined;
  /** The agent each run this view started was of, by run id. */
  readonly agentNames: ReadonlyMap<string, string>;
  readonly personName: (principalId: string) => string;
  readonly pending: boolean;
  readonly onRestore: (revision: PageRevision) => void;
}

function RevisionAuthor({
  revision,
  props,
}: {
  readonly revision: PageRevision;
  readonly props: PageRevisionListProps;
}): ReactNode {
  const { strings, platformUrl } = props;
  const runId = revision.run_id;
  if (runId === null) {
    return <p>{strings.savedBy(props.personName(revision.author_principal_id))}</p>;
  }
  return (
    <p>
      <span className="aw-app-badge" data-tone="info">
        {strings.agentBadge}
      </span>{' '}
      {strings.savedBy(props.agentNames.get(runId) ?? strings.anAgent)}{' '}
      {platformUrl === undefined ? (
        <code>{shortRunId(runId)}</code>
      ) : (
        <a href={runViewUrl(platformUrl, runId)} aria-label={strings.openRunLabel(runId)}>
          {shortRunId(runId)}
        </a>
      )}
    </p>
  );
}

/** The revisions of a page, newest first, each with its preview and Restore. Exported for tests. */
export function PageRevisionList(props: PageRevisionListProps): ReactNode {
  const { revisions, currentRevisionId, strings, locale } = props;
  if (revisions.length === 0) return <p className="aw-app-empty">{strings.noRevisions}</p>;
  return (
    <ol className="aw-app-page-revisions">
      {revisions.map((revision) => {
        const time = revisionTime(revision.at, locale);
        const current = revision.id === currentRevisionId;
        return (
          <li
            key={revision.id}
            className="aw-app-page-revision"
            data-agent={revision.run_id !== null}
          >
            <p>
              <time dateTime={revision.at}>{time}</time>
              {current ? (
                <>
                  {' '}
                  <span className="aw-app-badge">{strings.current}</span>
                </>
              ) : null}
            </p>
            <RevisionAuthor revision={revision} props={props} />
            <details className="aw-app-page-revision-preview">
              <summary>{strings.preview}</summary>
              <p className="aw-app-page-revision-title">{revision.title}</p>
              <AssistantProse text={blocksToMarkdown(revision.blocks)} />
            </details>
            {current ? null : (
              <button
                type="button"
                className="aw-app-button"
                aria-label={strings.restoreLabel(time)}
                disabled={props.pending}
                onClick={() => props.onRestore(revision)}
              >
                {strings.restore}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** What the person is editing: the title and the body. */
interface Draft {
  readonly title: string;
  readonly blocks: readonly RichTextBlock[];
}

/** An open agent action: the panel's agent and prompt, and its key so a new action starts afresh. */
interface Action {
  readonly key: number;
  readonly agent: string;
  readonly prompt: string;
}

/** The revisions drawer's state: what it shows, and the cursor of the next page. */
interface Drawer {
  readonly open: boolean;
  readonly items: readonly PageRevision[] | null;
  readonly nextCursor: string | null;
}

const CLOSED: Drawer = { open: false, items: null, nextCursor: null };

/** One page, with its revisions and its agent actions. */
export function PageView<F extends FieldMap>(props: PageViewProps<F>): ReactNode {
  const { resource, id, agents = [], onChanged } = props;
  const locale = useAppLocale(props.locale);
  const appText = appStrings(locale);
  const strings = appText.pages;
  const domId = useId();
  const client = useMemo(() => props.client ?? pageClient(resource), [props.client, resource]);
  const [page, setPage] = useState<PageRecord<F> | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState<PageConflictReason | null>(null);
  const [drawer, setDrawer] = useState<Drawer>(CLOSED);
  const [action, setAction] = useState<Action | null>(null);
  const [agentNames, setAgentNames] = useState<ReadonlyMap<string, string>>(new Map());
  // Read when a write answers, which may be after the drawer was opened or closed.
  const drawerOpen = useRef(false);
  useEffect(() => {
    drawerOpen.current = drawer.open;
  }, [drawer.open]);

  const fail = useCallback(
    (error: unknown) => {
      if (codeOf(error) === 'page_conflict') setConflict('conflict');
      else setProblem(problemMessage(appText, codeOf(error)));
    },
    [appText],
  );

  /** Shows `found` as the page and as what is being edited. */
  const show = useCallback((found: PageRecord<F>) => {
    setPage(found);
    setDraft({ title: titleOf(found), blocks: blocksOf(found) });
    setDirty(false);
    setConflict(null);
    setProblem(null);
  }, []);

  const loadRevisions = useCallback(
    (cursor: string | null = null) => {
      client.revisions(id, { cursor }).then(
        (found) =>
          setDrawer((current) => ({
            open: current.open,
            items: cursor === null ? found.items : [...(current.items ?? []), ...found.items],
            nextCursor: found.nextCursor,
          })),
        fail,
      );
    },
    [client, id, fail],
  );

  const load = useCallback(
    () =>
      client.get(id).then((found) => {
        show(found);
        return found;
      }),
    [client, id, show],
  );
  useEffect(() => {
    setDrawer(CLOSED);
    setAction(null);
    load().catch(fail);
  }, [load, fail]);

  /** After the page changed: the drawer read again when open, and the page told. */
  const changed = (found: PageRecord<F>, said: string | null): void => {
    setStatus(said);
    if (drawerOpen.current) loadRevisions();
    onChanged?.(found);
  };

  const save = (expectedRevisionId: string): void => {
    if (draft === null) return;
    setBusy(true);
    setProblem(null);
    client
      .update(id, { title: draft.title, blocks: draft.blocks, expectedRevisionId })
      .then((saved) => {
        show(saved);
        changed(saved, strings.saved);
      }, fail)
      .finally(() => setBusy(false));
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (page !== null) save(page.revision_id);
  };

  const keepMine = (): void => {
    client.get(id).then((latest) => {
      setPage(latest);
      save(latest.revision_id);
    }, fail);
  };

  const restore = (revision: PageRevision): void => {
    if (page === null) return;
    setBusy(true);
    client
      .restore(id, revision.id, { expectedRevisionId: page.revision_id })
      .then((restored) => {
        show(restored);
        changed(restored, strings.restored);
      }, fail)
      .finally(() => setBusy(false));
  };

  const onCompleted = ({ runId, agent }: AgentPanelCompletion): void => {
    setAgentNames((current) => new Map([...current, [runId, agent.label]]));
    if (dirty) {
      setConflict('agent');
      return;
    }
    load()
      .then((found) => changed(found, null))
      .catch(fail);
  };

  const open = (agent: AgentPanelAgent, prompt: string): void =>
    setAction((current) => ({ key: (current?.key ?? 0) + 1, agent: agent.name, prompt }));
  const summarize = (agent: AgentPanelAgent): void => {
    if (page === null) return;
    client.children(page.id).then((children) => {
      const childIds = children.slice(0, SUMMARY_CHILDREN_MAX).map((child) => child.id);
      const prompt = summarizePrompt({ id: page.id, title: titleOf(page) }, childIds, {
        name: resource.name,
        locale,
      });
      open(agent, prompt);
    }, fail);
  };

  if (page === null || draft === null) {
    return (
      <p className="aw-app-status" role="status">
        {problem ?? appText.loading}
      </p>
    );
  }

  const personName = (principalId: string): string =>
    props.personName?.(principalId) ?? strings.person(principalId);
  const first = agents[0];
  return (
    <div className="aw-app-page-view">
      <article className="aw-app-page-main" aria-labelledby={`${domId}-heading`}>
        <h1 id={`${domId}-heading`}>{titleOf(page) || strings.untitled}</h1>
        <p className="aw-app-status" role="status">
          {status}
        </p>
        {conflict === null ? null : (
          <PageConflictNotice
            reason={conflict}
            strings={strings}
            pending={busy}
            onLoadLatest={() => {
              load().catch(fail);
            }}
            onKeepMine={keepMine}
          />
        )}
        {problem === null ? null : (
          <p className="aw-app-alert" role="alert">
            {problem}
          </p>
        )}
        <form className="aw-app-form" onSubmit={onSubmit}>
          <div className="aw-app-field">
            <label htmlFor={`${domId}-title`} className="aw-app-label">
              {strings.titleLabel}
            </label>
            <input
              id={`${domId}-title`}
              value={draft.title}
              maxLength={PAGE_TITLE_MAX}
              required
              onChange={(event) => {
                setDraft({ ...draft, title: event.target.value });
                setDirty(true);
              }}
            />
          </div>
          <RichText
            value={draft.blocks}
            locale={locale}
            onChange={(blocks) => {
              setDraft({ ...draft, blocks });
              setDirty(true);
            }}
          />
          <div className="aw-app-actions">
            <button type="submit" className="aw-app-button aw-app-primary" disabled={busy}>
              {busy ? appText.saving : appText.save}
            </button>
          </div>
        </form>
        {first === undefined ? null : (
          <div className="aw-app-actions" role="group" aria-label={strings.actionsLabel}>
            {agents.map((agent) => (
              <button
                key={agent.name}
                type="button"
                className="aw-app-button"
                onClick={() =>
                  open(
                    agent,
                    rewritePrompt({ id: page.id, title: titleOf(page) }, page.revision_id, {
                      name: resource.name,
                      locale,
                    }),
                  )
                }
              >
                {strings.rewriteWith(agent.label)}
              </button>
            ))}
            <button type="button" className="aw-app-button" onClick={() => summarize(first)}>
              {strings.summarizeIntoNewPage}
            </button>
          </div>
        )}
        <button
          type="button"
          className="aw-app-button"
          aria-expanded={drawer.open}
          aria-controls={`${domId}-revisions`}
          onClick={() => {
            const opening = !drawer.open;
            setDrawer({ ...drawer, open: opening });
            if (opening) loadRevisions();
          }}
        >
          {drawer.open ? strings.hideRevisions : strings.showRevisions}
        </button>
        <section
          id={`${domId}-revisions`}
          className="aw-app-page-drawer"
          aria-labelledby={`${domId}-revisions-heading`}
          hidden={!drawer.open}
        >
          <h2 id={`${domId}-revisions-heading`}>{strings.revisionsHeading}</h2>
          {drawer.items === null ? (
            <p className="aw-app-status">{appText.loading}</p>
          ) : (
            <PageRevisionList
              revisions={drawer.items}
              currentRevisionId={page.revision_id}
              strings={strings}
              locale={locale}
              platformUrl={props.platformUrl}
              agentNames={agentNames}
              personName={personName}
              pending={busy}
              onRestore={restore}
            />
          )}
          {drawer.nextCursor === null ? null : (
            <button
              type="button"
              className="aw-app-button"
              onClick={() => loadRevisions(drawer.nextCursor)}
            >
              {appText.loadMore}
            </button>
          )}
        </section>
      </article>
      {first === undefined ? null : (
        <aside className="aw-app-page-aside" aria-label={appText.asideLabel}>
          <AgentPanel
            key={action?.key ?? 0}
            resource={resource}
            recordId={page.id}
            agents={agents}
            locale={locale}
            initialPrompt={action?.prompt}
            initialAgent={action?.agent}
            onCompleted={onCompleted}
            renderApproval={props.renderApproval}
            client={props.panelClient}
          />
        </aside>
      )}
    </div>
  );
}
