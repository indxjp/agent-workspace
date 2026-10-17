/**
 * `GET /p/s/<name>/widget.js` — the one-tag widget loader (ADR-0105 slice 1; ADR-0108; S1-18,
 * issue #456). A thin adapter: `serveWidgetLoader` in
 * `apps/web/server/surfaces/loader/handler.ts` decides everything and is tested without a server.
 * The route is where the chat's `surfaceWidgetLook` (the look's defaults and labels, from
 * `@indx-workspace/react/theme`) is passed to the server, which never imports a component itself.
 */
import { surfaceWidgetLook } from '@indx-workspace/react/theme';

import { serveWidgetLoader } from '../../../../../server/surfaces/loader/handler';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await context.params;
  return serveWidgetLoader(request, name, surfaceWidgetLook);
}
