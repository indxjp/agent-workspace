/**
 * The two discovery documents (ADR-0134 part 3): RFC 8414 authorization-server metadata and
 * RFC 9728 protected-resource metadata. Both are pure functions of `AW_PUBLIC_URL` and the request
 * path; neither reads the database, so neither says whether a client or project exists.
 */
import { oauthError, oauthJson, oauthNotConfigured } from './http';
import {
  A2A_RESOURCE_PREFIX,
  BUILDER_RESOURCE_PATH,
  MCP_RESOURCE_PREFIX,
  PROTECTED_RESOURCE_METADATA_PREFIX,
  publicOrigin,
} from './resource';

const SCOPES = ['endpoint'];

export function authorizationServerMetadata(): Response {
  const origin = publicOrigin();
  if (origin === null) return oauthNotConfigured();
  return oauthJson(
    200,
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      scopes_supported: SCOPES,
      authorization_response_iss_parameter_supported: true,
    },
    { 'cache-control': 'public, max-age=300' },
  );
}

export function protectedResourceMetadata(request: Request): Response {
  const origin = publicOrigin();
  if (origin === null) return oauthNotConfigured();
  const { pathname } = new URL(request.url);
  const resourcePath = pathname.slice(PROTECTED_RESOURCE_METADATA_PREFIX.length);
  const isBuilder = resourcePath === BUILDER_RESOURCE_PATH;
  const prefix = [MCP_RESOURCE_PREFIX, A2A_RESOURCE_PREFIX].find((p) => resourcePath.startsWith(p));
  const segment = prefix === undefined ? '' : resourcePath.slice(prefix.length);
  if (!isBuilder && (segment === '' || segment.includes('/'))) {
    return oauthError(404, 'invalid_target', 'No protected resource is published at this path.');
  }
  return oauthJson(
    200,
    {
      resource: `${origin}${resourcePath}`,
      authorization_servers: [origin],
      scopes_supported: SCOPES,
      bearer_methods_supported: ['header'],
    },
    { 'cache-control': 'public, max-age=300' },
  );
}
