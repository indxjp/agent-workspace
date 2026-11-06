'use client';
/**
 * The paging the list and the board share (issue #1508): the state lives in
 * {@link pagesReducer}; this hook only sends the request a transition asks for through the
 * resource's client and dispatches the answer.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';

import type { DefinedResource, FieldMap } from '../resource.js';
import type { RecordOf } from '../schemas.js';
import { resourceClient, type ResourceClient, type ResourcePage } from './client.js';
import {
  activeFilters,
  initialPages,
  pagesReducer,
  type PagesState,
} from './resource-view-model.js';

/** Where the records come from. */
export interface ResourcePagesSource<F extends FieldMap> {
  /** The client of the resource's routes; one for the page's own origin when not given. */
  readonly client?: ResourceClient<F> | undefined;
  /** The first page, when the server rendered it; it is fetched on mount otherwise. */
  readonly initialPage?: ResourcePage<RecordOf<F>> | undefined;
  /** The filters the first page was fetched with. */
  readonly initialFilters?: Readonly<Record<string, string>> | undefined;
  /** How many records a page asks for; the route's default when not given. */
  readonly pageSize?: number | undefined;
}

/** The paging state and the three things a person can do to it. */
export interface ResourcePages<F extends FieldMap> {
  readonly state: PagesState<RecordOf<F>>;
  readonly filter: (name: string, value: string) => void;
  readonly loadMore: () => void;
  readonly retry: () => void;
}

/** The records of `resource`, a page at a time. */
export function useResourcePages<F extends FieldMap>(
  resource: DefinedResource<F>,
  source: ResourcePagesSource<F>,
): ResourcePages<F> {
  const client = useMemo(
    () => source.client ?? resourceClient(resource),
    [source.client, resource],
  );
  const [state, dispatch] = useReducer(
    pagesReducer<RecordOf<F>>,
    initialPages(source.initialPage, source.initialFilters),
  );
  const seq = useRef(0);
  const { pageSize } = source;

  const request = useCallback(
    (filters: Readonly<Record<string, string>>, cursor: string | null) => {
      seq.current += 1;
      const current = seq.current;
      dispatch({ type: 'request', seq: current, append: cursor !== null, filters });
      client.list({ cursor, limit: pageSize, filters: activeFilters(resource, filters) }).then(
        (page) => {
          dispatch({
            type: 'loaded',
            seq: current,
            items: page.items,
            nextCursor: page.nextCursor,
          });
        },
        () => {
          dispatch({ type: 'failed', seq: current });
        },
      );
    },
    [client, pageSize, resource],
  );

  const firstLoad = useRef(source.initialPage === undefined);
  useEffect(() => {
    if (!firstLoad.current) return;
    firstLoad.current = false;
    request(state.filters, null);
  }, [request, state.filters]);

  return {
    state,
    filter: (name, value) => {
      request({ ...state.filters, [name]: value }, null);
    },
    loadMore: () => {
      request(state.filters, state.nextCursor);
    },
    retry: () => {
      request(state.filters, state.pending?.append === true ? state.nextCursor : null);
    },
  };
}
