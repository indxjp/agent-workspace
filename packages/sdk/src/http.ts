import type { z } from 'zod';

import {
  ApiProblemBareCodeSchema,
  ApiProblemDetailSchema,
  ApiProblemSchema,
  CONTRACTS_VERSION,
  CONTRACTS_VERSION_HEADER,
  type ApiProblem,
} from '@indx-workspace/contracts';
import type { PresignedUrl } from '@indx-workspace/contracts/files';

import {
  ApiProblemError,
  ContractsVersionUnsupportedError,
  ContractViolationError,
  InvalidArgumentError,
  TransportError,
} from './errors.js';
import { readContractsVersionSkew } from './version.js';

/**
 * How the client proves who it is.
 *
 * `api-key` sends a workspace API key (`ak_live_…`) as `Authorization: Bearer`; it is the
 * credential a customer's backend holds. `session` sends nothing and asks `fetch` to include the
 * browser's cookies, which is how a browser page on the control plane's own origin calls the API.
 * `browser-token` (issue #236, SDK-04, S-1) sends a short-lived, run- or session-scoped bearer a
 * customer's own backend minted for its own frontend (`aw.tokens.mint`); it sends `Authorization:
 * Bearer` exactly as `api-key` does and, like it, never sets `credentials: 'include'` — the
 * workspace API key must never reach a browser, but this token was minted *for* one.
 * `user-token` (issue #242, SDK-10, S-22) sends the `awu_live_…` token `aw login` holds: a person,
 * admitted only on the person-facing routes (`me`, `workspaces`, `team.invitations`, the sharing
 * policy, `auth.revoke` and `workspaces.select`; ADR-0083), and like the other two bearers never
 * `credentials: 'include'`.
 * `access-token` (ADR-0161) sends the `awo_live_…` token `aw.auth.exchange` returns: a backend
 * acting as the signed-in person, admitted only on the `app-backend` grammar's routes (start a run
 * on one of the endpoint client's bound agents, read and interrupt a run, and `me`) and only within
 * the person's own role and agent grants. It lasts 300 s, so a backend caches one per person and
 * exchanges again when it expires. Like the other bearers it never sets `credentials: 'include'`.
 */
export type ClientAuth =
  | { readonly kind: 'api-key'; readonly apiKey: string }
  | { readonly kind: 'session' }
  | { readonly kind: 'browser-token'; readonly token: string }
  | { readonly kind: 'user-token'; readonly token: string }
  | { readonly kind: 'access-token'; readonly token: string };

export interface ClientOptions {
  /** The control plane's origin, optionally with a path prefix: `https://aw.example.com`. */
  readonly baseUrl: string | URL;
  readonly auth: ClientAuth;
  /** Injected for tests and for runtimes that wrap `fetch`; defaults to the global. */
  readonly fetch?: typeof fetch;
  /**
   * Extra headers on every request, e.g. a trace id. Never used for credentials, and never the
   * contracts version: `X-Agent-Workspace-Contracts` is always the version this SDK was built
   * against.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** Abort a request that has produced no response headers within this many milliseconds. */
  readonly timeoutMs?: number;
  /**
   * Select this workspace (id or slug) before the first request — issue #236 (SDK-04, S-2).
   * Honoured only for `auth: { kind: 'session' }`; the constructor throws for any other kind,
   * since an API key and a browser token are each already bound to one fixed workspace. The
   * switch itself runs once, memoised, the first time any request is sent, and every concurrent
   * first caller awaits that same attempt rather than each triggering their own.
   */
  readonly workspace?: string;
  /**
   * Receives each deprecation warning instead of the console: a deprecated call in this client
   * (today, a `contentBase64` skill import file) passes it a fixed message that never carries a
   * value. Without it the first such warning in a process is one `console.warn` line; a handler
   * that does nothing silences them.
   */
  readonly onWarning?: (message: string) => void;
}

/** Messages already written to the console by a client with no `onWarning`, once per process. */
const consoleWarnings = new Set<string>();

/** Per-call options every operation accepts. */
export interface RequestOptions {
  readonly signal?: AbortSignal;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface SendSpec {
  /** Names the operation in every error, e.g. `agents.get`. */
  readonly operation: string;
  readonly method: HttpMethod;
  /** Relative to the base URL: `/api/agents/…`. Path segments are already encoded. */
  readonly path: string;
  readonly query?: URLSearchParams;
  /** JSON-encoded and sent as `application/json`; ignored when `rawBody` is set. */
  readonly body?: unknown;
  /**
   * Sent as-is, with no encoding and no `content-type` of the client's own; a caller that has one
   * sets it in `headers`. An upload of bytes (`POST /api/files`) is one case; a `FormData` is the
   * other (`POST /api/skills`), whose `multipart/form-data` header, boundary included, `fetch`
   * writes itself. Takes precedence over `body`, header and all.
   */
  readonly rawBody?: Blob | FormData;
  /** The statuses that mean success; anything else is read as a problem. */
  readonly expect: readonly number[];
  readonly signal?: AbortSignal | undefined;
  /** Headers this one request adds (`Accept: text/event-stream`, `Last-Event-ID`). */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RequestSpec<Schema extends z.ZodType> extends SendSpec {
  readonly schema: Schema;
}

const JSON_MEDIA_TYPE = 'application/json';

/** Join a base URL and an API path without doubling or losing the base's own path prefix. */
export function resolveApiUrl(baseUrl: string | URL, path: string, query?: URLSearchParams): URL {
  const base = new URL(String(baseUrl));
  const prefix = base.pathname.replace(/\/+$/u, '');
  const url = new URL(`${prefix}${path}`, base.origin);
  if (query !== undefined) url.search = query.toString();
  return url;
}

/**
 * The deadline for response headers, as a signal `fetch` can take and a `disarm` to call once
 * they arrive. `AbortSignal.timeout` cannot serve here: a signal handed to `fetch` stays live
 * after the response resolves, and aborting it errors the body — which would sever every event
 * stream at the deadline. A controller whose timer is cleared on resolution covers headers only.
 */
function headersDeadline(timeoutMs: number): {
  readonly signal: AbortSignal;
  readonly disarm: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(`no response headers within ${String(timeoutMs)} ms`, 'TimeoutError'),
    );
  }, timeoutMs);
  return {
    signal: controller.signal,
    disarm: () => {
      clearTimeout(timer);
    },
  };
}

/** The caller's signal, the deadline, both, or neither — as one signal `fetch` can take. */
function combinedSignal(
  callerSignal: AbortSignal | undefined,
  deadline: AbortSignal | undefined,
): AbortSignal | undefined {
  const signals = [callerSignal, deadline].filter((one): one is AbortSignal => one !== undefined);
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function requestBody(spec: SendSpec): Pick<RequestInit, 'body'> {
  if (spec.rawBody !== undefined) return { body: spec.rawBody };
  return spec.body === undefined ? {} : { body: JSON.stringify(spec.body) };
}

function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * Parse a problem envelope, dropping every key Zod names as unrecognised first. The envelope must
 * survive the served version range (`minimumServedContractsVersion`): a newer server may add a
 * field to it (a `requestId`, say), and that must not cost an older client the stable `code` it
 * branches on. The contracts schema stays `.strict()`, which holds the server's own envelopes to
 * the contract; any issue other than an unknown key is still a failure.
 */
function parseProblemEnvelope<Schema extends z.ZodType>(
  schema: Schema,
  body: unknown,
): z.ZodSafeParseResult<z.output<Schema>> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed;
  const unknownKeys = parsed.error.issues.filter((issue) => issue.code === 'unrecognized_keys');
  if (unknownKeys.length === 0) return parsed;
  const pruned: unknown = structuredClone(body);
  for (const issue of unknownKeys) {
    const holder = issue.path.reduce<unknown>(
      (value, segment) => (isObject(value) ? Reflect.get(value, segment) : undefined),
      pruned,
    );
    if (isObject(holder)) for (const key of issue.keys) Reflect.deleteProperty(holder, key);
  }
  return schema.safeParse(pruned);
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/**
 * Read a failure body as the standard envelope — which may still carry the deprecated duplicate
 * `detail`, ignored in favour of `message` — or as one of the two older spellings an older
 * deployment answers: `{ code, detail }` (the RBAC layer before SDK unit 6, #238) and the bare-code
 * `{ error: '<code>' }` (`POST /api/runtimes/test`, and `GET /api/audit-events` before #238). The
 * stable `code` a caller branches on survives whichever spelling arrived, and prose becomes
 * `message` in every case.
 */
function readProblem(body: unknown): ApiProblem['error'] | null {
  const standard = parseProblemEnvelope(ApiProblemSchema, body);
  if (standard.success) return standard.data.error;
  const detail = parseProblemEnvelope(ApiProblemDetailSchema, body);
  if (detail.success) return { code: detail.data.error.code, message: detail.data.error.detail };
  const bare = parseProblemEnvelope(ApiProblemBareCodeSchema, body);
  if (bare.success) return { code: bare.data.error, message: bare.data.message ?? '' };
  return null;
}

const CONTRACTS_VERSION_UNSUPPORTED = 'contracts_version_unsupported';

/**
 * Read a non-2xx body as a problem, or name it as unrecognised — never throw. A `426
 * contracts_version_unsupported` becomes the typed {@link ContractsVersionUnsupportedError}.
 */
async function problemFromResponse(response: Response): Promise<ApiProblemError> {
  const body: unknown = await response.json().catch(() => null);
  const problem = readProblem(body) ?? {
    code: 'unrecognised_error_body',
    message: `the server answered ${String(response.status)} without the platform's error envelope`,
  };
  if (response.status === 426 && problem.code === CONTRACTS_VERSION_UNSUPPORTED) {
    return new ContractsVersionUnsupportedError({
      problem,
      skew: readContractsVersionSkew(response.headers),
    });
  }
  return new ApiProblemError({
    status: response.status,
    problem,
    retryAfterSeconds: retryAfterSeconds(response),
  });
}

/** The headers every request starts from: the caller's extras, then what the SDK always sends. */
function baseHeaders(extra: Readonly<Record<string, string>> | undefined): Headers {
  const headers = new Headers(extra ?? {});
  headers.set(CONTRACTS_VERSION_HEADER, CONTRACTS_VERSION);
  return headers;
}

/**
 * The one HTTP path every resource client shares: build the request, send it, classify the
 * answer. A caller sees exactly one of three failures ({@link TransportError},
 * {@link ApiProblemError}, {@link ContractViolationError}) or a value the schema accepted.
 */
const WORKSPACE_SWITCH_PATH = '/api/auth/workspace';

function isHttpUrl(value: string | URL): boolean {
  try {
    const { protocol } = new URL(String(value));
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export class HttpClient {
  readonly #options: ClientOptions;
  readonly #fetch: typeof fetch;
  /** Memoised: the workspace switch runs once, and every concurrent first caller awaits it. */
  #workspaceSelected: Promise<void> | null = null;

  public constructor(options: ClientOptions) {
    if (options.workspace !== undefined && options.auth.kind !== 'session') {
      throw new Error(
        `ClientOptions.workspace is honoured only for auth: { kind: 'session' }; this client was ` +
          `built with auth.kind === ${JSON.stringify(options.auth.kind)}, which is already bound ` +
          `to one fixed workspace.`,
      );
    }
    // `localhost:3000` parses as a URL with the scheme `localhost:`, and `aw.example.com` not at
    // all; either would surface later as a bare TypeError from fetch (BH061-039).
    if (!isHttpUrl(options.baseUrl)) {
      throw new TypeError(
        `ClientOptions.baseUrl must be an absolute http(s) URL such as https://aw.example.com; ` +
          `got ${JSON.stringify(String(options.baseUrl))}.`,
      );
    }
    this.#options = options;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Which credential this client presents; a resource picks a route by it where two exist. */
  public get authKind(): ClientAuth['kind'] {
    return this.#options.auth.kind;
  }

  /** The base URL, for consumers that need to render an absolute link (e.g. the events URL). */
  public get baseUrl(): URL {
    return new URL(String(this.#options.baseUrl));
  }

  #headers(spec: SendSpec): Headers {
    const headers = baseHeaders(this.#options.headers);
    headers.set('accept', JSON_MEDIA_TYPE);
    if (spec.body !== undefined && spec.rawBody === undefined) {
      headers.set('content-type', JSON_MEDIA_TYPE);
    }
    if (this.#options.auth.kind === 'api-key') {
      headers.set('authorization', `Bearer ${this.#options.auth.apiKey}`);
    }
    if (
      this.#options.auth.kind === 'browser-token' ||
      this.#options.auth.kind === 'user-token' ||
      this.#options.auth.kind === 'access-token'
    ) {
      headers.set('authorization', `Bearer ${this.#options.auth.token}`);
    }
    for (const [name, value] of Object.entries(spec.headers ?? {})) headers.set(name, value);
    headers.set(CONTRACTS_VERSION_HEADER, CONTRACTS_VERSION);
    return headers;
  }

  /**
   * `POST /api/auth/workspace` with `Content-Type: application/json` (issue #236, SDK-04, S-2) —
   * a raw `fetch`, not a recursive {@link send}, so this cannot itself re-trigger the ensure-select
   * hook below. Its own failure becomes an {@link ApiProblemError} when a response arrives and a
   * {@link TransportError} when none does — a dropped connection, or the deadline below firing —
   * exactly as any other request's would; a caller sees it the first time it awaits a method on
   * this client.
   *
   * `ClientOptions.headers` and `ClientOptions.timeoutMs` apply here for the same reason they
   * apply to {@link send}: a tracing header a caller configured once should be on every request
   * this client makes, and a request with no deadline can hang where every other one is bounded.
   * The route's own `accept`/`content-type` are set after the configured headers, so they cannot
   * be overridden into a shape the JSON branch would not recognise.
   */
  async #selectWorkspace(workspace: string): Promise<void> {
    const url = resolveApiUrl(this.#options.baseUrl, WORKSPACE_SWITCH_PATH);
    const headers = baseHeaders(this.#options.headers);
    headers.set('accept', JSON_MEDIA_TYPE);
    headers.set('content-type', JSON_MEDIA_TYPE);
    const deadline =
      this.#options.timeoutMs === undefined ? undefined : headersDeadline(this.#options.timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ workspace }),
        credentials: 'include',
        ...(deadline === undefined ? {} : { signal: deadline.signal }),
      });
    } catch (cause) {
      throw new TransportError({
        operation: 'workspaces.select',
        aborted: deadline?.signal.aborted ?? false,
        cause,
      });
    } finally {
      deadline?.disarm();
    }
    if (!response.ok) throw await problemFromResponse(response);
    // The answer is not read; cancelling it releases the connection instead of holding it to GC.
    await response.body?.cancel().catch(() => undefined);
  }

  /**
   * Run the memoised switch, if `options.workspace` names one, before any other request.
   *
   * The memo holds the *fulfilled* attempt only. `??=` on its own would also cache a rejection,
   * so one transient failure — a `503`, a dropped connection — would make every later request on
   * this client re-throw that same error forever. Clearing the field from the rejection handler
   * keeps the "concurrent first callers share one attempt" property (they all await the promise
   * already in the field) while letting the next call try again.
   */
  #ensureWorkspaceSelected(): Promise<void> {
    const workspace = this.#options.workspace;
    if (workspace === undefined) return Promise.resolve();
    this.#workspaceSelected ??= this.#selectWorkspace(workspace).catch((error: unknown) => {
      this.#workspaceSelected = null;
      throw error;
    });
    return this.#workspaceSelected;
  }

  /**
   * Send one request and return the raw `Response`. Only the response *headers* are covered by
   * the timeout — the deadline is disarmed the moment `fetch` resolves, so a stream body may
   * legitimately stay open far longer — and a non-2xx status is already a thrown
   * {@link ApiProblemError} when this resolves.
   */
  public async send(spec: SendSpec): Promise<Response> {
    if (spec.path !== WORKSPACE_SWITCH_PATH) await this.#ensureWorkspaceSelected();
    const url = resolveApiUrl(this.#options.baseUrl, spec.path, spec.query);
    const deadline =
      this.#options.timeoutMs === undefined ? undefined : headersDeadline(this.#options.timeoutMs);
    const signal = combinedSignal(spec.signal, deadline?.signal);
    const init: RequestInit = {
      method: spec.method,
      headers: this.#headers(spec),
      ...requestBody(spec),
      ...(signal === undefined ? {} : { signal }),
      ...(this.#options.auth.kind === 'session' ? { credentials: 'include' as const } : {}),
    };
    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch (cause) {
      throw new TransportError({
        operation: spec.operation,
        aborted: spec.signal?.aborted === true || (signal?.aborted ?? false),
        cause,
      });
    } finally {
      deadline?.disarm();
    }
    if (!spec.expect.includes(response.status)) throw await problemFromResponse(response);
    return response;
  }

  /**
   * Send `body` to a presigned object-store URL, with exactly the headers it was signed for and
   * none of this client's own: the store gets no bearer, no contracts header and no cookies. The
   * body is handed to `fetch` as given (a `Blob` is streamed, not read), through the configured
   * `fetch`, under the same headers deadline as {@link send}. A refusal is an
   * {@link ApiProblemError} carrying the store's status.
   */
  public async putSigned(spec: {
    readonly operation: string;
    readonly target: Pick<PresignedUrl, 'url' | 'method' | 'headers'>;
    readonly body: Blob | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;
    readonly signal?: AbortSignal | undefined;
  }): Promise<void> {
    const deadline =
      this.#options.timeoutMs === undefined ? undefined : headersDeadline(this.#options.timeoutMs);
    const signal = combinedSignal(spec.signal, deadline?.signal);
    let response: Response;
    try {
      response = await this.#fetch(spec.target.url, {
        method: spec.target.method,
        headers: new Headers(spec.target.headers),
        body: spec.body,
        // A streamed body must say it is sent half-duplex.
        ...(spec.body instanceof ReadableStream ? { duplex: 'half' } : {}),
        credentials: 'omit',
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      throw new TransportError({
        operation: spec.operation,
        aborted: spec.signal?.aborted === true || (signal?.aborted ?? false),
        cause,
      });
    } finally {
      deadline?.disarm();
    }
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      // The store answers in its own format (S3 and Azure send XML), never the platform envelope.
      throw new ApiProblemError({
        status: response.status,
        problem: {
          code: 'unrecognised_error_body',
          message: `the object store refused the ${spec.target.method} (HTTP ${String(response.status)})`,
        },
        retryAfterSeconds: retryAfterSeconds(response),
      });
    }
  }

  /** Hand a deprecation warning to `onWarning`, or write it to the console once per process. */
  public warn(message: string): void {
    if (this.#options.onWarning !== undefined) {
      this.#options.onWarning(message);
      return;
    }
    if (consoleWarnings.has(message)) return;
    consoleWarnings.add(message);
    console.warn(message);
  }

  /** {@link send}, then parse the JSON body through `schema`. A `204` yields `null`. */
  public async json<Schema extends z.ZodType>(spec: RequestSpec<Schema>): Promise<z.infer<Schema>> {
    const response = await this.send(spec);
    let body: unknown;
    if (response.status === 204) {
      body = null;
    } else {
      try {
        body = await response.json();
      } catch (cause) {
        throw new ContractViolationError({
          operation: spec.operation,
          status: response.status,
          issues: [
            `the body is not JSON (${cause instanceof Error ? cause.message : String(cause)})`,
          ],
        });
      }
    }
    const parsed = spec.schema.safeParse(body);
    if (!parsed.success) {
      throw new ContractViolationError({
        operation: spec.operation,
        status: response.status,
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join('.') || '$'}: ${issue.message}`,
        ),
      });
    }
    return parsed.data;
  }
}

/**
 * The segments `encodeURIComponent` leaves as they are and that still change the resolved route:
 * an empty segment collapses or truncates the path, and `.`/`..` are dot segments the URL parser
 * removes — so does their `%2e` spelling, which is why encoding them is no fix. Every other value
 * survives encoding as one opaque segment (`/`, `?`, `#` and `%` are all escaped), so this set is
 * complete (issue #488).
 *
 * Written as comparisons rather than `new Set(['', '.', '..'])`: the §42 boundary gate
 * (`tests/no-sdk-import.test.ts`) decides a call by the strings it is handed, and `'.'` handed
 * to a constructor resolves to this package's index, so it refuses that form as undecidable.
 */
function isPathChangingSegment(value: string): boolean {
  return value === '' || value === '.' || value === '..';
}

/**
 * A lone UTF-16 surrogate: `encodeURIComponent` throws a raw `URIError` on it, so it is refused
 * as a typed error instead. A well-formed surrogate pair is one code point and does not match.
 */
const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * Percent-encode one path segment; every id in a path is caller-supplied text. Throws
 * {@link InvalidArgumentError} for `''`, `'.'` and `'..'`, which would address a different route
 * — `agents.get('..')` would otherwise reach `/api/` — and for a value holding a lone surrogate,
 * which cannot be encoded at all, before any request is made.
 */
export function segment(value: string): string {
  if (isPathChangingSegment(value) || LONE_SURROGATE.test(value)) {
    throw new InvalidArgumentError({ code: 'invalid_path_segment', value });
  }
  return encodeURIComponent(value);
}
