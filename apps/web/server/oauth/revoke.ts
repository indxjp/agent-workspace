/**
 * `POST /oauth/revoke` (RFC 7009; ADR-0134 part 3). A client revokes its own access or refresh
 * token; a refresh token takes its whole family with it. An unknown token answers `200` like a
 * known one, so the endpoint is not an oracle for which tokens exist.
 */
import { closeEndpointToolSandbox } from '../tool-endpoint/close';
import { authenticateClient } from './client-auth';
import { oauthError } from './http';
import { oauthTokenHash } from './tokens';

export async function revoke(request: Request): Promise<Response> {
  const auth = await authenticateClient(request);
  if (!auth.ok) return auth.response;
  const { client, form, runtime } = auth;

  const presented = form.get('token');
  if (presented === null || presented === '') {
    return oauthError(400, 'invalid_request', 'token is required.');
  }
  const tokens = await runtime.tokens(client.workspaceId);
  const hashes = await Promise.all([
    oauthTokenHash('refresh', presented),
    oauthTokenHash('access', presented),
  ]);
  for (const hash of hashes) {
    if (hash === null) continue;
    const revoked = await tokens.revoke(hash, client.id);
    if (revoked !== null) {
      // The grant's subject is the audit actor, as on `oauth-grant-issued`; the client has no
      // principal of its own.
      await runtime.audit(client.workspaceId, revoked.subjectPrincipalId, {
        action: 'oauth-grant-revoked',
        clientId: client.id,
        clientName: client.name,
        detail: revoked.kind,
      });
      if (client.kind === 'mcp-project') {
        await closeEndpointToolSandbox(client.workspaceId, client.id);
      }
      break;
    }
  }
  return new Response(null, {
    status: 200,
    headers: { 'cache-control': 'no-store', pragma: 'no-cache' },
  });
}
