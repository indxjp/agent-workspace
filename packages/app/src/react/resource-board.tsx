'use client';
/**
 * `ResourceBoard`: a resource's records as columns, one per value of an `enumOf()` field (the
 * resource's `board`, or `field`), each card a link to the record's detail (issue #1508). A
 * status change goes through `ResourceForm`; there is no drag and drop.
 */
import type { ReactNode } from 'react';

import type { DefinedResource, FieldMap } from '../resource.js';
import type { RecordOf } from '../schemas.js';
import {
  FieldCell,
  PagesFooter,
  useDisplayContext,
  type ResourceDisplayProps,
} from './resource-cell.js';
import {
  boardColumns,
  boardFieldOf,
  defaultDetailHref,
  fieldLabel,
  recordTitle,
} from './resource-view-model.js';
import { useResourcePages, type ResourcePagesSource } from './use-resource-pages.js';

/** The props of {@link ResourceBoard}. */
export interface ResourceBoardProps<F extends FieldMap>
  extends ResourceDisplayProps, ResourcePagesSource<F> {
  readonly resource: DefinedResource<F>;
  /** The `enumOf()` field the columns are the values of; the resource's `board` when not given. */
  readonly field?: (keyof F & string) | undefined;
  /** Where a card links to; `/<plural>/<id>` when not given. */
  readonly detailHref?: ((record: RecordOf<F>) => string) | undefined;
}

/**
 * The board: a list of columns, each a list item named by its value, in the enum's order. A
 * record whose value the field no longer defines is in no column. Every card is one link, so
 * the keyboard path is the tab order. Besides its title a card shows the other `enumOf()` and
 * `person()` fields.
 *
 * @throws {TypeError} when neither `field` nor the resource's `board` names an `enumOf()` field.
 */
export function ResourceBoard<F extends FieldMap>(props: ResourceBoardProps<F>): ReactNode {
  const { resource, labels, valueLabels, detailHref } = props;
  const field = boardFieldOf(resource, props.field);
  const context = useDisplayContext(props);
  const { strings } = context;
  const pages = useResourcePages(resource, props);
  const columns = boardColumns(resource, pages.state.items, field, valueLabels);
  const facets = Object.entries(resource.fields)
    .filter(([name, each]) => name !== field && (each.type === 'enumOf' || each.type === 'person'))
    .map(([name]) => name);
  const href = (record: RecordOf<F>): string =>
    detailHref?.(record) ?? defaultDetailHref(resource, record.id);

  return (
    <div className="aw-app-board-frame">
      <ul className="aw-app-board" aria-label={strings.boardLabel(fieldLabel(field, labels))}>
        {columns.map((column) => (
          <li key={column.value} className="aw-app-column" aria-label={column.label}>
            <h3 className="aw-app-column-heading">
              {column.label}{' '}
              <span className="aw-app-count">{strings.cardCount(column.records.length)}</span>
            </h3>
            {column.records.length === 0 ? (
              <p className="aw-app-empty">{strings.emptyColumn}</p>
            ) : (
              <ul className="aw-app-cards">
                {column.records.map((record) => (
                  <li key={record.id} className="aw-app-card">
                    <a href={href(record)} className="aw-app-card-title">
                      {recordTitle(resource, record)}
                    </a>
                    {facets.length > 0 ? (
                      <dl className="aw-app-card-facets">
                        {facets.map((name) => (
                          <div key={name}>
                            <dt>{fieldLabel(name, labels)}</dt>
                            <dd>
                              <FieldCell
                                resource={resource}
                                name={name}
                                record={record}
                                context={context}
                              />
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <PagesFooter
        state={pages.state}
        strings={strings}
        loadMore={pages.loadMore}
        retry={pages.retry}
      />
    </div>
  );
}
