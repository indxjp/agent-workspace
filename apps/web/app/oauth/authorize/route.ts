/** `GET`/`POST /oauth/authorize` — the consent page and its decision (ADR-0134 part 3). */
import { errorResponse } from '../../../server/http/error-response';
import { authorizeGet, authorizePost } from '../../../server/oauth/authorize';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  try {
    return await authorizeGet(request);
  } catch (cause) {
    return errorResponse(cause, { component: 'oauth', operation: 'authorize' });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await authorizePost(request);
  } catch (cause) {
    return errorResponse(cause, { component: 'oauth', operation: 'authorize-decision' });
  }
}
