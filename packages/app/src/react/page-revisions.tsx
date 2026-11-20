'use client';
/**
 * The conflict notice and the revisions list of `PageView` (issue #1521): the two choices a refused
 * save or an agent's change under unsaved edits offers, and each revision newest first with who
 * saved it, an agent badge, a link to its run, a preview and Restore.
 */
import { AssistantProse } from '@indx-workspace/react';
import type { ReactNode } from 'react';

import type { PageRevision } from '../db/page-port.js';
import { blocksToMarkdown } from '../pages/blocks.js';
import { runViewUrl, shortRunId } from './dashboard-model.js';
import type { AppLocale, PageStrings } from './locale.js';

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
