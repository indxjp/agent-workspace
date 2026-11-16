'use client';
/**
 * `ResourceDetail`: one record, every field as its cell shows it, `ref()` values as links and
 * `files()` values as read-only attachment chips, with a history slot and an `aside` slot (the
 * agent panel bound to the record, issue #1509) (issue #1508). Presentational: the record comes
 * in through props.
 */
import { AttachmentChips } from '@indx-workspace/react';
import type { ReactNode } from 'react';

import type { DefinedResource, FieldMap } from '../resource.js';
import type { RecordOf } from '../schemas.js';
import { FieldCell, useDisplayContext, type ResourceDisplayProps } from './resource-cell.js';
import { fieldLabel, fieldValue, recordTitle, shortId } from './resource-view-model.js';

/** The props of {@link ResourceDetail}. */
export interface ResourceDetailProps<F extends FieldMap> extends ResourceDisplayProps {
  readonly resource: DefinedResource<F>;
  readonly record: RecordOf<F>;
  /** The display name of an attached file, by platform file id; its short id when not given. */
  readonly fileName?: ((id: string) => string) | undefined;
  /** Where the edit link goes; no edit link when not given. */
  readonly editHref?: string | undefined;
  /** The record's history, drawn by the page (the app's audit rows); no section when not given. */
  readonly history?: ReactNode;
  /** Beside the record: the agent panel. No aside when not given. */
  readonly aside?: ReactNode;
}

/** The record's attachments: a read-only chip per file, no remove button. */
function Attachments({
  ids,
  fileName,
  none,
}: {
  readonly ids: readonly string[];
  readonly fileName: (id: string) => string;
  readonly none: string;
}): ReactNode {
  if (ids.length === 0) return <span className="aw-app-empty">{none}</span>;
  return (
    <span className="aw-app-attachments">
      <AttachmentChips
        items={ids.map((id) => ({ id, name: fileName(id) }))}
        classNames={{ chip: 'aw-app-chip' }}
      />
    </span>
  );
}

function fileIds(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/** One record: its title, its fields, then the history and aside slots. */
export function ResourceDetail<F extends FieldMap>(props: ResourceDetailProps<F>): ReactNode {
  const { resource, record, labels, editHref, history, aside } = props;
  const context = useDisplayContext(props);
  const { strings } = context;
  const fileName = props.fileName ?? shortId;
  const headingId = `${resource.name}-${record.id}-heading`;

  return (
    <div className="aw-app-detail">
      <article className="aw-app-record" aria-labelledby={headingId}>
        <header className="aw-app-record-header">
          <h1 id={headingId}>{recordTitle(resource, record)}</h1>
          {editHref === undefined ? null : (
            <a href={editHref} className="aw-app-button">
              {strings.edit}
            </a>
          )}
        </header>
        <section aria-label={strings.fieldsHeading}>
          <dl className="aw-app-fields">
            {Object.entries(resource.fields).map(([name, field]) => (
              <div key={name} className="aw-app-field-row" data-type={field.type}>
                <dt>{fieldLabel(name, labels)}</dt>
                <dd>
                  {field.type === 'files' ? (
                    <Attachments
                      ids={fileIds(fieldValue(record, name))}
                      fileName={fileName}
                      none={strings.noValue}
                    />
                  ) : (
                    <FieldCell resource={resource} name={name} record={record} context={context} />
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        {history === undefined ? null : (
          <section className="aw-app-history" aria-label={strings.historyLabel}>
            {history}
          </section>
        )}
      </article>
      {aside === undefined ? null : (
        <aside className="aw-app-aside" aria-label={strings.asideLabel}>
          {aside}
        </aside>
      )}
    </div>
  );
}
