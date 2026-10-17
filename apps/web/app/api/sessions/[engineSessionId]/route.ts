import { getSession, updateSession } from '../../../../server/sessions/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type SessionRouteContext = { params: Promise<{ engineSessionId: string }> };

async function idFrom(context: SessionRouteContext): Promise<string> {
  return (await context.params).engineSessionId;
}

export async function GET(request: Request, context: SessionRouteContext): Promise<Response> {
  return getSession(request, await idFrom(context));
}

export async function PATCH(request: Request, context: SessionRouteContext): Promise<Response> {
  return updateSession(request, await idFrom(context));
}
