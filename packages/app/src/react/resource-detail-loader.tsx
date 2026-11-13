'use client';
/**
 * `ResourceDetailLoader`: the detail page of one record by its id (issue #1507), and
 * `ResourceFormLoader`: the edit page of one record by its id (issue #1531). Each asks the
 * resource's client for the record and draws {@link ResourceDetail} or {@link ResourceForm} once
 * it has it; until then the polite status line, and when the record cannot be had the problem in
 * the person's words with a button to try again. The state lives in {@link recordReducer}; the
 * effect only sends the request and dispatches the answer, so a generated
 * `app/<plural>/[id]/page.tsx` or `app/<plural>/[id]/edit/page.tsx` stays a few lines.
 */
import { useEffect, useMemo, useReducer, type ReactNode } from 'react';

import type { DefinedResource, FieldMap } from '../resource.js';
import type { RecordOf } from '../schemas.js';
import { resourceClient, ResourceProblemError, type ResourceClient } from './client.js';
import { problemMessage, type AppStrings } from './locale.js';
import { useDisplayContext } from './resource-cell.js';
import { ResourceDetail, type ResourceDetailProps } from './resource-detail.js';
import { ResourceForm, type ResourceFormProps } from './resource-form.js';

/** The props of {@link ResourceDetailLoader}: the detail's, with the record's id for the record. */
export interface ResourceDetailLoaderProps<F extends FieldMap> extends Omit<
  ResourceDetailProps<F>,
  'record'
> {
  /** The id of the record to show, as the route's `[id]` segment holds it. */
  readonly id: string;
  /** The client of the resource's routes; one for the page's own origin when not given. */
  readonly client?: ResourceClient<F> | undefined;
}

/** The props of {@link ResourceFormLoader}: the form's, with the record's id for the record. */
export interface ResourceFormLoaderProps<F extends FieldMap> extends Omit<
  ResourceFormProps<F>,
  'record'
> {
  /** The id of the record to change, as the route's `[id]` segment holds it. */
  readonly id: string;
}

/** Where one record's request stands. `attempt` counts the requests asked for, retries included. */
export type RecordState<R> =
  | { readonly status: 'loading'; readonly attempt: number }
  | { readonly status: 'loaded'; readonly attempt: number; readonly record: R }
  | { readonly status: 'failed'; readonly attempt: number; readonly code: string };

/** What can happen to a record's request. */
export type RecordAction<R> =
  | { readonly type: 'request' }
  | { readonly type: 'retry' }
  | { readonly type: 'loaded'; readonly record: R }
  | { readonly type: 'failed'; readonly code: string };

/** The state before the first answer. */
export const INITIAL_RECORD_STATE: RecordState<never> = Object.freeze({
  status: 'loading',
  attempt: 0,
});

/**
 * The record's state after `action`: a request or a retry is loading again (a retry asks for a
 * new attempt, which the effect sends), an answer is loaded or failed with the problem's code.
 */
export function recordReducer<R>(state: RecordState<R>, action: RecordAction<R>): RecordState<R> {
  switch (action.type) {
    case 'request':
      return state.status === 'loading' ? state : { status: 'loading', attempt: state.attempt };
    case 'retry':
      return { status: 'loading', attempt: state.attempt + 1 };
    case 'loaded':
      return { status: 'loaded', attempt: state.attempt, record: action.record };
    case 'failed':
      return { status: 'failed', attempt: state.attempt, code: action.code };
  }
}

/** The record `id` of `resource`, asked of its client: the state, and `retry` after a failure. */
function useRecord<F extends FieldMap>(
  resource: DefinedResource<F>,
  id: string,
  given: ResourceClient<F> | undefined,
): { readonly state: RecordState<RecordOf<F>>; readonly retry: () => void } {
  const client = useMemo(() => given ?? resourceClient(resource), [given, resource]);
  const [state, dispatch] = useReducer(recordReducer<RecordOf<F>>, INITIAL_RECORD_STATE);
  const { attempt } = state;

  useEffect(() => {
    const controller = new AbortController();
    dispatch({ type: 'request' });
    client.get(id, { signal: controller.signal }).then(
      (record) => {
        if (!controller.signal.aborted) dispatch({ type: 'loaded', record });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        dispatch({
          type: 'failed',
          code: error instanceof ResourceProblemError ? error.code : 'other',
        });
      },
    );
    return () => {
      controller.abort();
    };
  }, [client, id, attempt]);

  return {
    state,
    retry: () => {
      dispatch({ type: 'retry' });
    },
  };
}

/** The status line of a record not loaded yet, or its problem with a button to try again. */
function RecordStatus({
  state,
  strings,
  onRetry,
}: {
  readonly state: RecordState<unknown>;
  readonly strings: AppStrings;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <div className="aw-app-detail">
      <p className="aw-app-status" role="status" aria-live="polite">
        {state.status === 'failed' ? problemMessage(strings, state.code) : strings.loading}
      </p>
      {state.status === 'failed' ? (
        <button type="button" className="aw-app-button" onClick={onRetry}>
          {strings.retry}
        </button>
      ) : null}
    </div>
  );
}

/** The record `id` of the resource, loaded through its client, then drawn as its detail. */
export function ResourceDetailLoader<F extends FieldMap>(
  props: ResourceDetailLoaderProps<F>,
): ReactNode {
  const { id, client, ...detail } = props;
  const strings = useDisplayContext(detail).strings;
  const { state, retry } = useRecord(detail.resource, id, client);
  if (state.status === 'loaded') return <ResourceDetail {...detail} record={state.record} />;
  return <RecordStatus state={state} strings={strings} onRetry={retry} />;
}

/** The record `id` of the resource, loaded through its client, then drawn as a form that changes it. */
export function ResourceFormLoader<F extends FieldMap>(
  props: ResourceFormLoaderProps<F>,
): ReactNode {
  const { id, ...form } = props;
  const strings = useDisplayContext(form).strings;
  const { state, retry } = useRecord(form.resource, id, form.client);
  if (state.status === 'loaded') return <ResourceForm {...form} record={state.record} />;
  return <RecordStatus state={state} strings={strings} onRetry={retry} />;
}
