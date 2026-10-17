import { shareJson, shareProblem, withPublicShare } from '../../../../server/shares/core/http';
import { RunnableShareService } from '../../../../server/shares/runnable/service';
import { runnablePublicLinksEnabled } from '../../../../server/shares/runnable/feature';
import { resolvePublicVisitorIdentity } from '../../../../server/shares/runnable/visitor-identity';
import { errorResponse } from '../../../../server/http/error-response';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OIDC login and callback moved to `apps/web/app/api/auth/{login,callback}` — issue #118. This
  // branch is not replaced by a redirect: `oidc-transactions` was never a public share token, and
  // §34 puts the public surface under `/p/` on the promise that everything here is unauthenticated
  // share traffic, which OIDC login/callback state never was.
  if (!runnablePublicLinksEnabled()) {
    return shareProblem(404, 'runnable_links_disabled', 'Runnable public links are not available.');
  }
  return withPublicShare(token, async ({ service, sharing, workspaceId, runPublic }) => {
    try {
      const body = (await shareJson(request)) as { prompt?: unknown; passphrase?: unknown };
      const visitor = resolvePublicVisitorIdentity(request.headers);
      if (!visitor.ok) {
        return shareProblem(
          visitor.code === 'visitor_identity_not_configured' ? 503 : 400,
          visitor.code,
          visitor.message,
        );
      }
      const share = await service.resolve(
        token,
        typeof body.passphrase === 'string' ? body.passphrase : undefined,
      );
      const runnable = new RunnableShareService(sharing, ({ share, prompt, sessionId }) =>
        runPublic({ workspaceId, share, prompt, sessionId }),
      );
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      return Response.json(await runnable.message(share, prompt, visitor.visitorKey), {
        status: 202,
      });
    } catch (error) {
      return errorResponse(error, {
        component: 'public-shares',
        operation: 'run-message',
      });
    }
  });
}
