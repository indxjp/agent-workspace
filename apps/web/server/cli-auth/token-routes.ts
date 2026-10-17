/**
 * Issue #242 (SDK-10, S-22): the person-facing routes the token `aw login` holds (`awu_live_…`)
 * is admitted on, and nowhere else. ADR-0083 §4.
 *
 * One list, read at two layers so neither is the only gate: `apps/web/proxy.ts` lets such a bearer
 * past the edge only on these paths, and `session-rbac.ts`'s `resolveActor` refuses to resolve it
 * on any other path — which matters where the edge admits a bearer for another reason (the
 * runner's run token on `/api/sessions/**`) or a session cookie rides along with it.
 *
 * Pure and dependency-free: the proxy imports it.
 */
export const CLI_TOKEN_ROUTE_PREFIXES: readonly string[] = [
  '/api/me',
  '/api/workspaces',
  '/api/invitations',
  '/api/sharing-policies',
  '/api/auth/cli-token',
  '/api/auth/cli-workspace',
];

/** Whether a user token may be presented on `pathname` (the prefix itself or a path below it). */
export function isCliTokenRoutePath(pathname: string): boolean {
  return CLI_TOKEN_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
