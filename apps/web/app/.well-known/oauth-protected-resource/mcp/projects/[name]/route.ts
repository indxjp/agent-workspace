/** `GET /.well-known/oauth-protected-resource/mcp/projects/:name` — RFC 9728 metadata (ADR-0134 part 3). */
import { protectedResourceMetadata } from '../../../../../../server/oauth/metadata';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(request: Request): Response {
  return protectedResourceMetadata(request);
}
