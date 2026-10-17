/** `POST /oauth/token` — the OAuth 2.1 token endpoint for endpoint clients (ADR-0134 part 3). */
import { errorResponse } from '../../../server/http/error-response';
import { token } from '../../../server/oauth/token';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    return await token(request);
  } catch (cause) {
    return errorResponse(cause, { component: 'oauth', operation: 'token' });
  }
}
