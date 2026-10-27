/**
 * `GET /p/s/<name>/widget.js` — the one-tag widget loader (ADR-0105 slice 1; ADR-0108; S1-18,
 * issue #456). Served exactly where the page it frames is: {@link readSurfacePage} checks
 * ADR-0105's conditions 1–3, the name grammar and the `local` pointer (C9), and anything it
 * refuses is the same `404 surface_not_found` as an unknown name.
 *
 * On the loopback branch the script's origin is the one the request was addressed to: the scheme
 * of `request.url` and the `Host` header, as `/p/s/<name>/try` prints the tag. It is not
 * `request.url`'s own origin, because Next.js's server rebuilds that from the host it listens on
 * (`localhost`), not the one asked (`127.0.0.1`); a frame of the other origin is then refused by
 * the surface's `frame-ancestors 'self'`, and the widget opens an empty panel. Reading `Host` is
 * safe only because conditions 1–3 have already held — a local runtime asked over a loopback
 * `Host` — so the origin cannot be a name an outside caller chose. On the allowed-origin branch
 * (issue #622) neither holds — behind a TLS proxy `request.url`'s scheme is `http` — so the
 * script reads its origin from its own URL instead. The look comes through `lookOf`, injected by
 * the route, so this server module imports no component (the components' `surfaceWidgetLook`
 * holds the defaults).
 */
import type { SurfaceDefinition } from '@indx-workspace/contracts/surfaces';

import { noStoreResultResponse } from '../../http/result';
import type { SurfaceConditionEnvironment } from '../public/conditions';
import { readSurfacePage, surfaceModeOfQuery, surfaceNotFound } from '../public/handlers';
import { renderWidgetLoader, type WidgetLook } from './render';

/** The headers a served loader carries. */
export const WIDGET_LOADER_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/javascript; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/** The look the loader draws a surface with, from its definition and its agent's name. */
export type WidgetLookOf = (surface: SurfaceDefinition, agentName: string) => WidgetLook;

/**
 * The origin `request` was addressed to. Conditions 1–3 have held, so `Host` is present and
 * loopback; `URL` normalises it (case, default port) the way `renderWidgetLoader` checks it.
 */
function requestedOrigin(request: Request): string {
  const { protocol, origin } = new URL(request.url);
  const host = request.headers.get('host');
  return host === null ? origin : new URL(`${protocol}//${host}`).origin;
}

/**
 * Serve the loader of surface `name`, or `404 surface_not_found`. The try page asks with
 * `?environment=local` (issue #612), and its loader frames the page with the same query.
 */
export async function serveWidgetLoader(
  request: Request,
  name: string,
  lookOf: WidgetLookOf,
  env: SurfaceConditionEnvironment = process.env,
): Promise<Response> {
  const mode = surfaceModeOfQuery(new URL(request.url).searchParams.get('environment'));
  const page = await readSurfacePage(name, request.headers, env, mode);
  if (page === null) return noStoreResultResponse(surfaceNotFound());
  const body = renderWidgetLoader(
    page.branch === 'loopback' ? requestedOrigin(request) : null,
    page.surfaceName,
    lookOf(page.surface, page.agentName),
    mode,
  );
  return new Response(body, { status: 200, headers: WIDGET_LOADER_HEADERS });
}
