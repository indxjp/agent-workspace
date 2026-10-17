/** `POST /oauth/revoke` — RFC 7009 token revocation for endpoint clients (ADR-0134 part 3). */
import { errorResponse } from '../../../server/http/error-response';
import { revoke } from '../../../server/oauth/revoke';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  try {
    return await revoke(request);
  } catch (cause) {
    return errorResponse(cause, { component: 'oauth', operation: 'revoke' });
  }
}
