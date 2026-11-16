import { type RouteFeature } from '../features.js';
import { API_SCHEMAS } from './schemas.js';

/** The name of a schema in {@link API_SCHEMAS}. */
export type ApiSchemaName = keyof typeof API_SCHEMAS;

/** The methods a public route answers. */
export type ApiRouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * What travels in a request or response body.
 *
 * - `json` — `application/json`, parsed with the named schema; more than one name lists the
 *   alternatives a route answers on the same status (a client tells them apart by shape).
 * - `json-undescribed` — `application/json` the contracts do not yet describe (see the header).
 * - `binary` — opaque bytes (`application/octet-stream`, or the stored file's own type).
 * - `event-stream` — `text/event-stream`; `frames` names the schemas of each frame's `data:`.
 * - `multipart` — `multipart/form-data`, its parts named in the order they must be sent.
 * - `none` — no body (`204`, or a request that sends nothing).
 */
export type ApiBody =
  | { readonly kind: 'json'; readonly schemas: readonly [ApiSchemaName, ...ApiSchemaName[]] }
  | { readonly kind: 'json-undescribed' }
  | { readonly kind: 'binary' }
  | { readonly kind: 'event-stream'; readonly frames: readonly ApiSchemaName[] }
  | {
      readonly kind: 'multipart';
      readonly parts: readonly [ApiMultipartPart, ...ApiMultipartPart[]];
    }
  | { readonly kind: 'none' };

/**
 * One named part of a `multipart` body: a `text` field, or `file` bytes. A `repeated` part is
 * sent once per item under the same name, at least once.
 */
export interface ApiMultipartPart {
  readonly name: string;
  readonly type: 'text' | 'file';
  readonly repeated?: true;
  readonly description: string;
}

/**
 * One request header a route reads beyond the ones every route shares (the contracts version and
 * the credential). The header's value is a string; its rules and refusals are in `description`.
 */
export interface ApiRequestHeader {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}

/** One success answer of a route. Failures are the standard envelope and are not listed per route. */
export interface ApiSuccess {
  readonly status: number;
  readonly body: ApiBody;
}

/** One public route and the contracts it is parsed with. */
export interface ApiRoute {
  readonly method: ApiRouteMethod;
  /** The path in the specification's own notation: `:id`, not `[id]` or `{id}`. */
  readonly path: string;
  /** Stable and unique: the SDK operation name where one exists (`agents.list`). */
  readonly operationId: string;
  /** The SDK resource family the route belongs to; the OpenAPI tag. */
  readonly tag: string;
  /**
   * The feature this route belongs to (ADR-0160 D4), or `core`. Required, so a route cannot be
   * added without saying which switch turns it off.
   */
  readonly feature: RouteFeature;
  readonly summary: string;
  /** Absent when the request carries no body. */
  readonly request?: ApiBody;
  /** Request headers this route reads beyond the shared ones; absent when it reads none. */
  readonly headers?: readonly ApiRequestHeader[];
  /**
   * Older request bodies the route still accepts beside `request`, each on its own media type,
   * kept for one release and then removed (04 §4). The OpenAPI document marks them deprecated.
   */
  readonly deprecatedRequests?: readonly ApiBody[];
  readonly success: readonly ApiSuccess[];
  /** Kept for one release and replaced by another route (04 §4). */
  readonly deprecated?: true;
  /**
   * How the caller proves who it is, when that is not the default — a workspace API key, a
   * browser token or the control plane's session cookie. Mirrors the public and identity-only
   * routes of `apps/web/server/rbac/authorisation-matrix.test.ts`:
   *
   * - `none` — no identity proof at all;
   * - `session-cookie` — only the control plane's own browser session (the route is exempt from
   *   the proxy's session gate and checks the cookie itself);
   * - `invitation-identity` — the invitation-identity cookie, not a workspace credential;
   * - `user-token` — only the `awu_live_` token `aw login` holds, which the route acts on itself
   *   (revoke it, move it to another workspace; ADR-0083);
   * - `endpoint-credential` — only an endpoint-scoped key, a workspace API key or (T1c) an OAuth
   *   access token, never a browser session: the published-agent endpoint (ADR-0135) is exempt
   *   from the proxy's session gate and authenticates the bearer itself.
   */
  readonly security?: ApiRouteSecurity;
}

/** A non-default credential requirement of a route (see {@link ApiRoute.security}). */
export type ApiRouteSecurity =
  'none' | 'session-cookie' | 'invitation-identity' | 'user-token' | 'endpoint-credential';

export const json = (first: ApiSchemaName, ...rest: ApiSchemaName[]): ApiBody => ({
  kind: 'json',
  schemas: [first, ...rest],
});
export const BINARY: ApiBody = { kind: 'binary' };
export const NONE: ApiBody = { kind: 'none' };
export const ok = (body: ApiBody): readonly ApiSuccess[] => [{ status: 200, body }];
export const created = (body: ApiBody): readonly ApiSuccess[] => [{ status: 201, body }];

export const UNDESCRIBED: ApiBody = { kind: 'json-undescribed' };
export const NO_CONTENT: readonly ApiSuccess[] = [{ status: 204, body: NONE }];
