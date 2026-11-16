'use client';
/**
 * `ResourceList`: a resource's records as a table, one column per field, with the filters its
 * `enumOf()`, `person()` and `date()` fields offer and cursor paging (issue #1508). Driven by the
 * `defineResource` result alone; the records come in as a first page or through the resource's
 * client, never by a `fetch` of its own.
 */
import { useId, type ReactNode } from 'react';

import type { DefinedResource, FieldMap } from '../resource.js';
import type { RecordOf } from '../schemas.js';
import type { AppStrings } from './locale.js';
import {
  FieldCell,
  PagesFooter,
  useDisplayContext,
  type ResourceDisplayProps,
} from './resource-cell.js';
import {
  columnsOf,
  defaultDetailHref,
  filtersOf,
  humanize,
  recordTitle,
  titleField,
  type FilterView,
} from './resource-view-model.js';
import { useResourcePages, type ResourcePagesSource } from './use-resource-pages.js';

/** The props of {@link ResourceList}. */
export interface ResourceListProps<F extends FieldMap>
  extends ResourceDisplayProps, ResourcePagesSource<F> {
  readonly resource: DefinedResource<F>;
  /** Where a record's title links to; `/<plural>/<id>` when not given. */
  readonly detailHref?: ((record: RecordOf<F>) => string) | undefined;
  /** Whether to offer the filters; `true` when not given. */
  readonly showFilters?: boolean | undefined;
}

interface FilterControlProps {
  readonly filter: FilterView;
  readonly id: string;
  readonly value: string;
  readonly strings: AppStrings;
  readonly people: Readonly<Record<string, string>> | undefined;
  readonly onChange: (value: string) => void;
}

function FilterControl({
  filter,
  id,
  value,
  strings,
  people,
  onChange,
}: FilterControlProps): ReactNode {
  if (filter.kind === 'date') {
    return (
      <input
        id={id}
        type="date"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    );
  }
  const options =
    filter.kind === 'enum'
      ? filter.options
      : Object.entries(people ?? {}).map(([principal, name]) => ({
          value: principal,
          label: name,
        }));
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    >
      <option value="">{strings.filterAny}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/**
 * A table of the resource's records. A filter change starts again from the first page; "Load
 * more" appends the next. A `person()` filter is offered only when `people` names the choices.
 */
export function ResourceList<F extends FieldMap>(props: ResourceListProps<F>): ReactNode {
  const { resource, labels, valueLabels, people, detailHref, showFilters = true } = props;
  const context = useDisplayContext(props);
  const { strings } = context;
  const base = useId();
  const pages = useResourcePages(resource, props);
  const { items } = pages.state;
  const columns = columnsOf(resource, labels);
  const titled = titleField(resource) ?? columns[0]?.name;
  const filters = filtersOf(resource, labels, valueLabels).filter(
    (filter) => filter.kind !== 'person' || people !== undefined,
  );
  const href = (record: RecordOf<F>): string =>
    detailHref?.(record) ?? defaultDetailHref(resource, record.id);

  return (
    <div className="aw-app-list">
      {showFilters && filters.length > 0 ? (
        <form
          className="aw-app-filters"
          role="search"
          aria-label={strings.filtersLabel}
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          {filters.map((filter) => {
            const id = `${base}-filter-${filter.name}`;
            return (
              <div key={filter.name} className="aw-app-filter">
                <label htmlFor={id}>{filter.label}</label>
                <FilterControl
                  filter={filter}
                  id={id}
                  value={pages.state.filters[filter.name] ?? ''}
                  strings={strings}
                  people={people}
                  onChange={(value) => {
                    pages.filter(filter.name, value);
                  }}
                />
              </div>
            );
          })}
        </form>
      ) : null}
      <table className="aw-app-table">
        <caption className="aw-app-sr-only">{strings.listLabel(humanize(resource.plural))}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.name} scope="col" data-cell={column.cell}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="aw-app-empty">
                {strings.emptyList}
              </td>
            </tr>
          ) : (
            items.map((record) => (
              <tr key={record.id}>
                {columns.map((column) => (
                  <td key={column.name} data-cell={column.cell}>
                    {column.name === titled ? (
                      <a href={href(record)}>{recordTitle(resource, record)}</a>
                    ) : (
                      <FieldCell
                        resource={resource}
                        name={column.name}
                        record={record}
                        context={context}
                      />
                    )}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      <PagesFooter
        state={pages.state}
        strings={strings}
        loadMore={pages.loadMore}
        retry={pages.retry}
      />
    </div>
  );
}
