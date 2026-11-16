/**
 * What the four resource parts share: the props that say a value in a person's words, and the
 * one renderer of a {@link CellView} (issue #1508). Presentational and pure.
 */
import type { ReactNode } from 'react';

import type { DefinedResource } from '../resource.js';
import { useAppLocale } from './locale-context.js';
import { appStrings, type AppLocale, type AppStrings } from './locale.js';
import {
  cellView,
  fieldValue,
  type CellView,
  type DisplayContext,
  type FieldLabels,
  type PagesState,
  type RecordValues,
  type ValueLabels,
} from './resource-view-model.js';

/** The props every resource part takes besides the resource and its data. */
export interface ResourceDisplayProps {
  /** The language of the part's own words; the `AppTheme`'s when not given, `en` outside one. */
  readonly locale?: AppLocale | undefined;
  /** The page's names for fields; a field without one reads humanised (`due_on` → `Due on`). */
  readonly labels?: FieldLabels | undefined;
  /** The page's names for enum values, by field. */
  readonly valueLabels?: ValueLabels | undefined;
  /** Display names of the workspace's people by principal id, for `person()` fields. */
  readonly people?: Readonly<Record<string, string>> | undefined;
  /** Where a `ref()` value links to; `/<resource>s/<id>` when not given. */
  readonly refHref?: ((resource: string, id: string) => string) | undefined;
  /** The time zone date-times are shown in; `UTC` when not given. */
  readonly timeZone?: string | undefined;
}

/** The display context of a part's props. */
function displayContextOf(props: ResourceDisplayProps): DisplayContext {
  const locale = props.locale ?? 'en';
  return {
    strings: appStrings(locale),
    locale,
    people: props.people,
    valueLabels: props.valueLabels,
    refHref: props.refHref,
    timeZone: props.timeZone,
  };
}

/**
 * The display context of a part's props inside a page: without a `locale` of its own, the part
 * speaks the language of the `AppTheme` around it (`locale-context.ts`).
 */
export function useDisplayContext(props: ResourceDisplayProps): DisplayContext {
  const locale = useAppLocale(props.locale);
  return displayContextOf({ ...props, locale });
}

/** The value of field `name` of `record`, drawn as the field's cell. */
export function FieldCell({
  resource,
  name,
  record,
  context,
}: {
  readonly resource: DefinedResource;
  readonly name: string;
  readonly record: RecordValues;
  readonly context: DisplayContext;
}): ReactNode {
  const field = resource.fields[name];
  if (field === undefined) return null;
  return <CellValue view={cellView(name, field, fieldValue(record, name), context)} />;
}

/** The props of {@link PagesFooter}. */
interface PagesFooterProps {
  readonly state: PagesState<unknown>;
  readonly strings: AppStrings;
  readonly loadMore: () => void;
  readonly retry: () => void;
}

/**
 * Under a list or a board: the polite status line (loading, or why a page failed with a button
 * to try again) and "Load more" while there is a next page. Native buttons, so the keyboard path
 * is the tab order.
 */
export function PagesFooter({ state, strings, loadMore, retry }: PagesFooterProps): ReactNode {
  const loading = state.status === 'loading';
  return (
    <div className="aw-app-pages">
      <p className="aw-app-status" role="status" aria-live="polite">
        {loading ? strings.loading : state.status === 'failed' ? strings.loadFailed : ''}
      </p>
      {state.status === 'failed' ? (
        <button type="button" className="aw-app-button" onClick={retry}>
          {strings.retry}
        </button>
      ) : null}
      {state.nextCursor !== null && state.status !== 'failed' ? (
        <button type="button" className="aw-app-button" onClick={loadMore} disabled={loading}>
          {strings.loadMore}
        </button>
      ) : null}
    </div>
  );
}

/** One value, drawn as its cell kind says. */
function CellValue({ view }: { readonly view: CellView }): ReactNode {
  switch (view.kind) {
    case 'empty':
      return <span className="aw-app-empty">{view.text}</span>;
    case 'text':
      return view.text;
    case 'time':
      return <time dateTime={view.dateTime}>{view.text}</time>;
    case 'badge':
      return (
        <span className="aw-app-badge" data-value={view.value}>
          {view.text}
        </span>
      );
    case 'person':
      return (
        <span className="aw-app-person">
          <span className="aw-app-avatar" aria-hidden="true">
            {view.initial}
          </span>
          {view.text}
        </span>
      );
    case 'link':
      return <a href={view.href}>{view.text}</a>;
    case 'chips':
      return (
        <ul className="aw-app-chips">
          {view.items.map((item) => (
            <li key={item} className="aw-app-chip">
              {item}
            </li>
          ))}
        </ul>
      );
  }
}
