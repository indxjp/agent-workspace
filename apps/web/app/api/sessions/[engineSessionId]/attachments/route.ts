/**
 * `POST /api/sessions/:engineSessionId/attachments` — a surface visitor's browser token uploads one
 * file into its own session (issue #1308, ADR-0146 D6). The handler is
 * `apps/web/server/surfaces/public/attachments.ts`.
 *
 * §34 does not print it, so `tests/route-declarations/P7-2-SURFACE-ATTACHMENTS-1308.ts` carries a
 * `mandate` citing §16 (ADR-0026).
 */
import { route } from '../../../../../server/http/route';
import { uploadSessionAttachment } from '../../../../../server/surfaces/public/attachments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = route(
  { component: 'surfaces', operation: 'upload-attachment' },
  async (
    request: Request,
    context: RouteContext<'/api/sessions/[engineSessionId]/attachments'>,
  ): Promise<Response> => uploadSessionAttachment(request, (await context.params).engineSessionId),
);
