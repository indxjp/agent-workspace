/** `GET /.well-known/oauth-protected-resource/mcp/builder` — RFC 9728 metadata (#1846 slice 5b). */
import { protectedResourceMetadata } from '../../../../../server/oauth/metadata';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Response {
  return protectedResourceMetadata(request);
}
