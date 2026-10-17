/**
 * `TokenScope` — issue #236 (SDK-04, S-1)'s attenuation: what a browser token narrows its
 * minter's role down to. Kept in its own module, imported by both `./principal.ts` (which carries
 * one on a `Principal`) and `./decide.ts` (whose `AuthorisationQuery` requires one), so neither of
 * those two modules depends on the other merely to share this shape.
 */

/** The two shapes a browser token may be scoped to (spec §3.1). */
export const TOKEN_SCOPE_KINDS = ['run', 'session'] as const;

/**
 * The two shapes an endpoint-scoped API key is bound to (ADR-0134): one agent's A2A endpoint, or
 * one MCP project endpoint. A browser token never carries one of these, so they are not part of
 * {@link TOKEN_SCOPE_KINDS}, which mirrors the `browser_tokens` column.
 */
export const ENDPOINT_SCOPE_KINDS = ['a2a-agent', 'mcp-project'] as const;

/** One of {@link TOKEN_SCOPE_KINDS} or {@link ENDPOINT_SCOPE_KINDS}. */
export type TokenScopeKind =
  (typeof TOKEN_SCOPE_KINDS)[number] | (typeof ENDPOINT_SCOPE_KINDS)[number];

/** What a browser token narrows to: a {@link TokenScope} whose kind is one of {@link TOKEN_SCOPE_KINDS}. */
export interface BrowserTokenScope {
  readonly kind: (typeof TOKEN_SCOPE_KINDS)[number];
  readonly id: string;
}

/** Whether `kind` is one an endpoint-scoped API key carries. */
export function isEndpointScope(kind: TokenScopeKind): boolean {
  return kind === 'a2a-agent' || kind === 'mcp-project';
}

/**
 * Which row a scoped credential may act on. `id` is that row's id (a run, a session, the agent of
 * an `a2a-agent` key, the endpoint client of an `mcp-project` key); the route shapes each kind may
 * reach are §3.1's grammar, enforced by `decide()`, and the row-identity half of the same rule (a
 * session scope's run must belong to that session) is enforced where the row is read.
 */
export interface TokenScope {
  readonly kind: TokenScopeKind;
  readonly id: string;
}
