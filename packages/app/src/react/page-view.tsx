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
import { useId, type ReactNode } from 'react';

import { PAGE_TITLE_MAX } from '../pages/define-pages.js';
import type { FieldMap } from '../resource.js';
import { AgentPanel, type AgentPanelAgent } from './agent-panel.js';
import type { PageStrings } from './locale.js';
import { PageConflictNotice, PageRevisionList } from './page-revisions.js';
import type { PageViewProps } from './page-view-props.js';
import { RichText } from './rich-text.js';
import { titleOf, usePageView } from './use-page-view.js';

export { PageConflictNotice, PageRevisionList } from './page-revisions.js';
export type { PageViewProps } from './page-view-props.js';

type PageView$ = ReturnType<typeof usePageView>;

/** The title, the body and Save. */
function PageEditor({
  view,
  domId,
  onSubmit,
}: {
  readonly view: PageView$;
  readonly domId: string;
  readonly onSubmit: PageView$['submit'];
}): ReactNode {
  const { draft, strings, appText, busy, locale, edit } = view;
  if (draft === null) return null;
  return (
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
          onChange={(event) => edit({ title: event.target.value })}
        />
      </div>
      <RichText value={draft.blocks} locale={locale} onChange={(blocks) => edit({ blocks })} />
      <div className="aw-app-actions">
        <button type="submit" className="aw-app-button aw-app-primary" disabled={busy}>
          {busy ? appText.saving : appText.save}
        </button>
      </div>
    </form>
  );
}

/** "Rewrite with <agent>" for each agent, and "Summarize into new page" with the first. */
function PageAgentActions({
  agents,
  first,
  strings,
  onRewrite,
  onSummarize,
}: {
  readonly agents: readonly AgentPanelAgent[];
  readonly first: AgentPanelAgent;
  readonly strings: PageStrings;
  readonly onRewrite: (agent: AgentPanelAgent) => void;
  readonly onSummarize: (agent: AgentPanelAgent) => void;
}): ReactNode {
  return (
    <div className="aw-app-actions" role="group" aria-label={strings.actionsLabel}>
      {agents.map((agent) => (
        <button
          key={agent.name}
          type="button"
          className="aw-app-button"
          onClick={() => onRewrite(agent)}
        >
          {strings.rewriteWith(agent.label)}
        </button>
      ))}
      <button type="button" className="aw-app-button" onClick={() => onSummarize(first)}>
        {strings.summarizeIntoNewPage}
      </button>
    </div>
  );
}

/** The revisions drawer: its toggle, the list, and Load more. */
function RevisionsDrawer({
  view,
  domId,
  revisionId,
  platformUrl,
  personName,
}: {
  readonly view: PageView$;
  readonly domId: string;
  readonly revisionId: string;
  readonly platformUrl: string | undefined;
  readonly personName: (principalId: string) => string;
}): ReactNode {
  const { drawer, strings, appText, locale } = view;
  return (
    <>
      <button
        type="button"
        className="aw-app-button"
        aria-expanded={drawer.open}
        aria-controls={`${domId}-revisions`}
        onClick={view.toggleDrawer}
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
            currentRevisionId={revisionId}
            strings={strings}
            locale={locale}
            platformUrl={platformUrl}
            agentNames={view.agentNames}
            personName={personName}
            pending={view.busy}
            onRestore={view.restore}
          />
        )}
        {drawer.nextCursor === null ? null : (
          <button type="button" className="aw-app-button" onClick={view.loadMore}>
            {appText.loadMore}
          </button>
        )}
      </section>
    </>
  );
}

/** One page, with its revisions and its agent actions. */
export function PageView<F extends FieldMap>(props: PageViewProps<F>): ReactNode {
  const view = usePageView(props);
  const domId = useId();
  const { page, draft, strings, appText, agents, conflict, problem } = view;
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
          {view.status}
        </p>
        {conflict === null ? null : (
          <PageConflictNotice
            reason={conflict}
            strings={strings}
            pending={view.busy}
            onLoadLatest={view.loadLatest}
            onKeepMine={view.keepMine}
          />
        )}
        {problem === null ? null : (
          <p className="aw-app-alert" role="alert">
            {problem}
          </p>
        )}
        <PageEditor view={view} domId={domId} onSubmit={view.submit} />
        {first === undefined ? null : (
          <PageAgentActions
            agents={agents}
            first={first}
            strings={strings}
            onRewrite={view.rewrite}
            onSummarize={view.summarize}
          />
        )}
        <RevisionsDrawer
          view={view}
          domId={domId}
          revisionId={page.revision_id}
          platformUrl={props.platformUrl}
          personName={personName}
        />
      </article>
      {first === undefined ? null : (
        <aside className="aw-app-page-aside" aria-label={appText.asideLabel}>
          <AgentPanel
            key={view.action?.key ?? 0}
            resource={props.resource}
            recordId={page.id}
            agents={agents}
            locale={view.locale}
            initialPrompt={view.action?.prompt}
            initialAgent={view.action?.agent}
            onCompleted={view.onCompleted}
            renderApproval={props.renderApproval}
            client={props.panelClient}
          />
        </aside>
      )}
    </div>
  );
}
