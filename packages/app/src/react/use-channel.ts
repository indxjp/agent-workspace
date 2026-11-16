'use client';
/**
 * `useChannel(name, key)`: the live events of one key of an app's `channel()` (issue #1518), read
 * from `GET /api/channels/<name>/events?key=<key>` as the signed-in person. The state lives in
 * {@link channelReducer}; following is {@link followChannel}, which reconnects with
 * `Last-Event-ID`, backs off on `retry:`, and discards the events held on `stream-reset`.
 */
import { useEffect, useReducer, useRef } from 'react';

import { channelEventsPath } from '../channel-wire.js';
import {
  channelReducer,
  followChannel,
  INITIAL_CHANNEL_STATE,
  type ChannelEphemeral,
  type ChannelState,
} from './channel-follow.js';

/** What {@link useChannel} may be told. */
export interface UseChannelOptions {
  /** The app's origin and path prefix; `''` (the page's own origin) when not given. */
  readonly baseUrl?: string;
  /** Injected for tests; the global `fetch` when not given. */
  readonly fetch?: typeof fetch;
  /** Called with each ephemeral event (presence, typing), which the state does not hold. */
  readonly onEphemeral?: (event: ChannelEphemeral) => void;
}

/** The URL of the stream of `key` of the channel `name`. */
export function channelEventsUrl(name: string, key: string, baseUrl = ''): string {
  const query = new URLSearchParams({ key });
  return `${baseUrl.replace(/\/+$/u, '')}${channelEventsPath(name)}?${query.toString()}`;
}

/**
 * The events of `key` of the channel `name`, oldest first, and where following stands. Following
 * starts on mount and when `name` or `key` changes, and stops on unmount.
 */
export function useChannel(
  name: string,
  key: string,
  options: UseChannelOptions = {},
): ChannelState {
  const [state, dispatch] = useReducer(channelReducer, INITIAL_CHANNEL_STATE);
  const onEphemeral = useRef(options.onEphemeral);
  useEffect(() => {
    onEphemeral.current = options.onEphemeral;
  }, [options.onEphemeral]);
  const { baseUrl, fetch } = options;

  useEffect(() => {
    const abort = new AbortController();
    dispatch({ type: 'reset' });
    void followChannel({
      url: channelEventsUrl(name, key, baseUrl),
      ...(fetch === undefined ? {} : { fetch }),
      signal: abort.signal,
      onEvent: (event) => dispatch({ type: 'event', event }),
      onEphemeral: (event) => onEphemeral.current?.(event),
      onReset: () => dispatch({ type: 'reset' }),
      onStatus: (status) => dispatch({ type: 'status', status }),
    }).then((end) => {
      if (end.kind === 'refused') dispatch({ type: 'refused', problem: end.problem });
    });
    return () => abort.abort();
  }, [name, key, baseUrl, fetch]);

  return state;
}
