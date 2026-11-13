/**
 * The dashboard's way to the app's `GET /api/dashboard` (issue #1522), and the poller that asks it
 * every second while the page is visible. `Dashboard` never calls `fetch` itself. The answer is
 * parsed with the wire's schema; a failure is one {@link ResourceProblemError}, its code the
 * route's own.
 */
import { ApiProblemSchema } from '@indx-workspace/contracts';

import {
  DASHBOARD_PATH,
  DashboardSnapshotSchema,
  type DashboardSnapshot,
} from '../dashboard-wire.js';
import { ResourceProblemError } from './client.js';

/** Where the dashboard route is and how to reach it. */
export interface DashboardClientOptions {
  /** The app's origin and path prefix; `''` (the page's own origin) when not given. */
  readonly baseUrl?: string;
  /** Injected for tests; the global `fetch` when not given. */
  readonly fetch?: typeof fetch;
}

/** The app's dashboard route. */
export interface DashboardClient {
  get(options?: { readonly signal?: AbortSignal }): Promise<DashboardSnapshot>;
}

function problemOf(status: number, body: unknown): ResourceProblemError {
  const parsed = ApiProblemSchema.safeParse(body);
  if (parsed.success) {
    const { code, message } = parsed.data.error;
    return new ResourceProblemError({ code, status, message });
  }
  return new ResourceProblemError({
    code: 'unrecognised_error_body',
    status,
    message: `the dashboard answered ${String(status)} without the problem envelope`,
  });
}

/** Builds the client of the dashboard route at `options.baseUrl`. */
export function dashboardClient(options: DashboardClientOptions = {}): DashboardClient {
  const url = `${(options.baseUrl ?? '').replace(/\/+$/u, '')}${DASHBOARD_PATH}`;
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    async get(getOptions = {}) {
      const init: RequestInit = {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...(getOptions.signal === undefined ? {} : { signal: getOptions.signal }),
      };
      const response = await send(url, init).catch(() => {
        throw new ResourceProblemError({
          code: 'transport_failed',
          status: 0,
          message: `GET ${DASHBOARD_PATH} got no answer`,
        });
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (response.status !== 200) throw problemOf(response.status, body);
      const parsed = DashboardSnapshotSchema.safeParse(body);
      if (parsed.success) return parsed.data;
      throw new ResourceProblemError({
        code: 'contract_violation',
        status: response.status,
        message: `GET ${DASHBOARD_PATH} answered a body the dashboard wire refuses`,
      });
    },
  };
}

/** The part of `document` the poller reads: whether the page is seen, and when that changes. */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** What {@link pollWhileVisible} runs and how often. */
export interface PollOptions {
  /** One tick: it must settle, and should stop when `signal` aborts. */
  readonly tick: (signal: AbortSignal) => Promise<void>;
  readonly intervalMs: number;
  /** The wait before the first tick; `0` when not given. */
  readonly firstDelayMs?: number;
  /** `document` in a browser; injected for tests. */
  readonly visibility: VisibilitySource;
}

/**
 * Runs `tick` every `intervalMs` after the previous tick settled, never two at once, and only
 * while the page is visible: hiding it aborts the tick in flight and pauses, showing it again ticks
 * at once. Each tick has its own `AbortController`. Returns the function that stops it for good.
 * The dashboard's polling is the shortcut `dashboardRoutes` declares.
 */
export function pollWhileVisible(options: PollOptions): () => void {
  const { tick, intervalMs, visibility } = options;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | undefined;
  const visible = (): boolean => visibility.visibilityState === 'visible';

  function schedule(delayMs: number): void {
    if (stopped || inFlight !== undefined || timer !== undefined || !visible()) return;
    timer = setTimeout(() => {
      timer = undefined;
      run();
    }, delayMs);
  }

  function run(): void {
    if (stopped || inFlight !== undefined || !visible()) return;
    const abort = new AbortController();
    inFlight = abort;
    void tick(abort.signal)
      .catch(() => undefined)
      .finally(() => {
        if (inFlight === abort) inFlight = undefined;
        schedule(intervalMs);
      });
  }

  function onVisibilityChange(): void {
    if (visible()) {
      schedule(0);
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    inFlight?.abort();
  }

  visibility.addEventListener('visibilitychange', onVisibilityChange);
  schedule(options.firstDelayMs ?? 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
    inFlight?.abort();
    visibility.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
