/** `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata (ADR-0134 part 3). */
import { authorizationServerMetadata } from '../../../server/oauth/metadata';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(): Response {
  return authorizationServerMetadata();
}
