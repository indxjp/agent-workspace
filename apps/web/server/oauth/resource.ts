/**
 * The two protected resources an OAuth access token is valid for (ADR-0134 part 3), as paths, and
 * what a `401` from either of them tells a client about where to authorise. A pure function of the
 * path and `AW_PUBLIC_URL`; nothing here reads the database.
 */
import { readPublicUrl } from '../endpoints/public-url';

export const MCP_RESOURCE_PREFIX = '/mcp/projects/';
export const A2A_RESOURCE_PREFIX = '/api/a2a/agents/';
export const PROTECTED_RESOURCE_METADATA_PREFIX = '/.well-known/oauth-protected-resource';

export const mcpResourcePath = (name: string): string =>
  `${MCP_RESOURCE_PREFIX}${encodeURIComponent(name)}`;
export const a2aResourcePath = (name: string): string =>
  `${A2A_RESOURCE_PREFIX}${encodeURIComponent(name)}`;

/** The configured origin, or `null` when `AW_PUBLIC_URL` is unset or unusable. */
export function publicOrigin(env: Readonly<Record<string, string | undefined>> = process.env) {
  const url = readPublicUrl(env);
  return url.ok ? url.origin : null;
}

/** The token audience of a resource path: the URL the platform registered, or `null`. */
export function resourceUrl(path: string): string | null {
  const origin = publicOrigin();
  return origin === null ? null : `${origin}${path}`;
}

/**
 * `WWW-Authenticate` for a `401` at `path` (RFC 6750, RFC 9728 §5.1). `resource_metadata` is left
 * out when no issuer is configured, since there is then nothing to discover.
 */
export function bearerChallenge(path: string, error?: 'invalid_token'): string {
  const origin = publicOrigin();
  const parts = ['Bearer realm="agent-workspace"'];
  if (error !== undefined) parts.push(`error="${error}"`);
  if (origin !== null) {
    parts.push(`resource_metadata="${origin}${PROTECTED_RESOURCE_METADATA_PREFIX}${path}"`);
  }
  return parts.join(', ');
}
