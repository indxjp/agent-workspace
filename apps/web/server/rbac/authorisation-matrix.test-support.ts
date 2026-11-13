import { readDeclarationFiles, requireString } from '../../../../tests/inventory-support';
import { ROLES, type Role } from './core/roles';
import { decide, OWNERSHIPS, type Decision, type Ownership } from './decide';

export const ROUTE_DECLARATIONS = 'tests/route-declarations';

export interface DeclaredRoute {
  readonly method: string;
  readonly path: string;
  readonly owner: string;
  /** Where it was declared, for a failure message that names a file rather than a route. */
  readonly where: string;
}

export function key(route: { method: string; path: string }): string {
  return `${route.method} ${route.path}`;
}

function declaredRoutes(): DeclaredRoute[] {
  return readDeclarationFiles(ROUTE_DECLARATIONS, 'routes').flatMap((file) =>
    file.entries.map((entry, index) => {
      const where = `${file.repoPath} entry ${String(index)}`;
      return {
        method: requireString(entry, 'method', where),
        path: requireString(entry, 'path', where),
        owner: requireString(entry, 'owner', where),
        where,
      };
    }),
  );
}

interface Cell {
  readonly route: DeclaredRoute;
  readonly role: Role;
  readonly ownership: Ownership;
  readonly decision: Decision;
}

export function matrix(routes: readonly DeclaredRoute[]): Cell[] {
  return routes.flatMap((route) =>
    ROLES.flatMap((role) =>
      OWNERSHIPS.map((ownership) => ({
        route,
        role,
        ownership,
        decision: decide({ role, method: route.method, path: route.path, ownership, scope: null }),
      })),
    ),
  );
}

export function undecidedCells(cells: readonly Cell[]): string[] {
  return cells
    .filter((cell) => cell.decision.effect === 'refuse')
    .map(
      (cell) =>
        `${key(cell.route)} (${cell.route.owner}, declared in ${cell.route.where}) × role ` +
        `${cell.role} × ownership ${cell.ownership}: ${cell.decision.because}`,
    );
}

export const PUBLIC_ROUTES = new Set([
  'GET /api/setup/runtime-detect',
  'GET /api/auth/login',
  'POST /api/auth/callback',
  'GET /api/auth/workspace',
  'POST /api/auth/workspace',
  // Issue #242 (ADR-0083): the start and poll of `aw login`, proved by the signed device code alone,
  // and the approval page, which renders "sign in first" itself when there is no session.
  'POST /api/auth/cli-device',
  'GET /api/auth/cli-verify',
  'POST /api/auth/cli-token',
  // ADR-0161 D3: an app backend exchanges an ID token, authenticating its endpoint client by its
  // secret; the token it gets acts as the person, and decide() gates every route it then reaches.
  'POST /api/auth/token-exchange',
  // ADR-0120 clause 7: called by Vercel Cron with `CRON_SECRET` as the bearer, never by a person.
  'GET /api/cron/retention',
  // ADR-0144 D5: the schedule pass, called by the platform cron with the same `CRON_SECRET` bearer.
  'GET /api/cron/triggers',
  // Issue #1674: the storage cleanup, called by the platform cron with the same `CRON_SECRET` bearer.
  'GET /api/cron/storage-cleanup',
  // ADR-0144: the secret in the path is the whole authentication of a trigger fire.
  'POST /api/triggers/:id/fire/:secret',
  // Issue #1562: the readiness probe a kubelet calls with no credential.
  'GET /api/readyz',
  // ADR-0134 part 3: the OAuth discovery documents (RFC 8414, RFC 9728) are public by protocol,
  // and the token and revocation endpoints authenticate the endpoint client itself, never a member.
  'GET /.well-known/oauth-authorization-server',
  'GET /.well-known/oauth-protected-resource/mcp/projects/:name',
  'GET /.well-known/oauth-protected-resource/mcp/builder',
  'GET /.well-known/oauth-protected-resource/api/a2a/agents/:agentName',
  'POST /oauth/token',
  'POST /oauth/revoke',
]);

export const IDENTITY_ONLY_ROUTES = new Set([
  'POST /api/invitations/:id/accept',
  // Issue #242 (ADR-0083): acts on the own sign-in of the caller, not on a workspace resource a role
  // grants: approving a code needs the browser session, signing out and switching need the CLI
  // token itself, and each route verifies that proof through the same `identify()`. (No quote
  // marks in these comments: `tests/docs/openapi.test.ts` reads the entries by their quotes.)
  'POST /api/auth/cli-verify',
  'DELETE /api/auth/cli-token',
  'POST /api/auth/cli-workspace',
  // ADR-0135: a published agent's A2A endpoint and its card. The caller proves itself with an API
  // key, the handler runs decide() for POST on the agent's runs route and refuses every other
  // credential, so no route-level role gate applies here.
  'POST /api/a2a/agents/:agentName',
  'GET /api/a2a/agents/:agentName/.well-known/agent-card.json',
  // ADR-0134 part 2: an mcp-project endpoint client's tool endpoint, reached with its endpoint API
  // key; the handler runs decide() for POST on each agent's runs route, as the A2A endpoint does.
  'POST /mcp/projects/:name',
  // Issue #1846 slice 5b: the read-only Builder door for an outside MCP client. The handler
  // accepts only a `builder`-kind OAuth token and answers every write tool `read_only_client`.
  'POST /mcp/builder',
  // ADR-0134 part 3: the consent page. The handler requires a browser session through identify()
  // and refuses an API key or an OAuth token; the grant it issues is scoped to one endpoint client.
  'GET /oauth/authorize',
  'POST /oauth/authorize',
  // Issue #1846: the aw-control MCP door. A run token is the whole identity proof and the handler
  // refuses every other credential, so no route-level role gate applies; the Builder tools decide
  // what the person behind the run may do.
  'POST /api/builder/mcp',
  // Issue #1517 (ADR-0104 acceptance decision 4): a team lead run's member tools. The lead run's
  // own token is the whole identity proof, refused for any other run; each member call is then
  // decided as POST on that member agent's runs route for the person behind the lead run.
  'POST /api/runs/:id/members/mcp',
]);

export const allRoutes = declaredRoutes();

export const publicRoutes = allRoutes.filter((route) => PUBLIC_ROUTES.has(key(route)));

export const identityOnlyRoutes = allRoutes.filter((route) => IDENTITY_ONLY_ROUTES.has(key(route)));

export const routes = allRoutes.filter(
  (route) => !PUBLIC_ROUTES.has(key(route)) && !IDENTITY_ONLY_ROUTES.has(key(route)),
);

export const cells = matrix(routes);
