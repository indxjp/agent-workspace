import { API_ROUTE_EXCLUSIONS, API_ROUTES, type ApiBody } from '@indx-workspace/contracts/routes';
import { describe, expect, it } from 'vitest';
import { readDeclarationFiles, requireString } from '../inventory-support.js';
import { document, routeKey as key } from './openapi.test-support.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Every `METHOD /path` the route inventory declares. */
function declaredRoutes(): Set<string> {
  const declared = new Set<string>();
  for (const file of readDeclarationFiles('tests/route-declarations', 'routes')) {
    for (const entry of file.entries) {
      declared.add(
        key(
          requireString(entry, 'method', file.repoPath),
          requireString(entry, 'path', file.repoPath),
        ),
      );
    }
  }
  return declared;
}

/** Every `METHOD /path` in the emitted document, in the specification's `:id` notation. */
function documentedRoutes(doc: Record<string, unknown>): Set<string> {
  const documented = new Set<string>();
  const paths = doc['paths'] as Record<string, Record<string, unknown>>;
  for (const [openApiPath, item] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      if (method in item) documented.add(key(method, openApiPath.replace(/\{([^}]+)\}/gu, ':$1')));
    }
  }
  return documented;
}

/** The two reasons a declared route may stay out of the document (ADR-0080). */
const BROWSER_JOURNEY = /\(04 §1\)$/u;

const PRIVATE_RUNNER_ROUTE = 'private runner route (per-run token)';

/** The Vercel Cron retention job: called by the platform, never by an SDK client (ADR-0120 clause 7). */
const PLATFORM_CRON_JOB = 'platform cron job (CRON_SECRET bearer)';

/** The web server's readiness probe: called by the platform's kubelet, never by an SDK client (#1562). */
const PLATFORM_READINESS_PROBE = 'platform readiness probe (no credential)';

/** The Builder's `aw-control` MCP door: called by the gateway with a run token, never by an SDK client (#1846). */
const RUN_CALLER_ROUTE = 'run-caller route (per-run token, aw-control tools)';

/** A team lead run's member tools (ADR-0104 decision 4): only the lead run's engine calls them. */
const LEAD_RUN_ROUTE =
  "lead-run route (the lead run's own token, agent-team member tools; ADR-0104)";

/** The OAuth 2.1 server's protocol endpoints (ADR-0134 part 3): specified by an RFC, not by this API. */
const OAUTH_PROTOCOL_ROUTE = /\(RFC \d+\)/u;

/**
 * The bodies the contracts do not describe yet, frozen: the live set may only shrink. A new route
 * brings its schemas; each schema added removes its line here.
 */
const UNDESCRIBED_BODIES = [
  'GET /api/setup/runtime-detect 200',
  'PATCH /api/agents/:id request',
  'PATCH /api/connectors/:id request',
  'PATCH /api/memberships/:id request',
  'PATCH /api/model-connections/:id request',
  'PATCH /api/projects/:id request',
  'PATCH /api/runtime-profiles/:id request',
  'PATCH /api/sessions/:engineSessionId request',
  'PATCH /api/skills/:name request',
  'PATCH /api/workspaces/:id request',
  'POST /api/agents request',
  'POST /api/api-keys request',
  'POST /api/connectors request',
  'POST /api/invitations request',
  'POST /api/invitations/:id/accept request',
  'POST /api/memberships request',
  'POST /api/model-connections request',
  'POST /api/model-connections/:id/credential request',
  'POST /api/projects request',
  'POST /api/projects/:id/sessions request',
  'POST /api/runs/:id request',
  'POST /api/runs/:id/revoke-tokens request',
  'POST /api/runtime-connections request',
  'POST /api/runtime-profiles request',
  'POST /api/runtimes/:id 200',
  'POST /api/runtimes/:id request',
  'POST /api/secrets request',
  'POST /api/shares request',
  'POST /api/skills request',
  'POST /api/users request',
  'POST /api/workspaces request',
  'PUT /api/secrets/:id request',
];

describe('route coverage', () => {
  it(
    'excludes only browser journeys, private runner routes, OAuth protocol endpoints, the platform cron job, the readiness probe, the run-caller route and the lead-run route',
    excludesOnlyBrowserJourneysPrivateRunnerRoutes,
  );

  it(
    'catalogues every declared route that is not an exclusion, and nothing else',
    cataloguesEveryDeclaredRouteThatIsNot,
  );

  it(
    'emits one operation per catalogued route, and no other',
    emitsOneOperationPerCataloguedRouteNo,
  );
});

describe('undescribed bodies', () => {
  it(
    'only shrink: no route adds a body without a contract schema',
    onlyShrinkNoRouteAddsBodyWithout,
  );
});

function excludesOnlyBrowserJourneysPrivateRunnerRoutes() {
  const reasons = API_ROUTE_EXCLUSIONS.filter(
    (route) =>
      !BROWSER_JOURNEY.test(route.because) &&
      !OAUTH_PROTOCOL_ROUTE.test(route.because) &&
      route.because !== PRIVATE_RUNNER_ROUTE &&
      route.because !== PLATFORM_CRON_JOB &&
      route.because !== PLATFORM_READINESS_PROBE &&
      route.because !== RUN_CALLER_ROUTE &&
      route.because !== LEAD_RUN_ROUTE,
  );
  assertOAuthAndCronExclusions();
  assertPlatformOnlyExclusions();
  expect(reasons, 'an exclusion that is neither kind').toEqual([]);
  assertPrivateRunnerExclusions();
}

function cataloguesEveryDeclaredRouteThatIsNot() {
  const declared = declaredRoutes();
  const excluded = new Set(API_ROUTE_EXCLUSIONS.map((route) => key(route.method, route.path)));
  const catalogued = new Set(API_ROUTES.map((route) => key(route.method, route.path)));

  const staleExclusions = [...excluded].filter((route) => !declared.has(route));
  expect(staleExclusions, 'an exclusion names a route nobody declares').toEqual([]);
  const withoutContract = [...declared].filter(
    (route) => !excluded.has(route) && !catalogued.has(route),
  );
  expect(
    withoutContract,
    'declared routes with no entry in packages/contracts/src/routes.ts',
  ).toEqual([]);
  const undeclared = [...catalogued].filter((route) => !declared.has(route) || excluded.has(route));
  expect(undeclared, 'catalogued routes the inventory does not declare as public').toEqual([]);
  expect(catalogued.size).toBe(API_ROUTES.length);
}

function emitsOneOperationPerCataloguedRouteNo() {
  const catalogued = new Set(API_ROUTES.map((route) => key(route.method, route.path)));
  expect(documentedRoutes(document)).toEqual(catalogued);
}

function onlyShrinkNoRouteAddsBodyWithout() {
  const undescribed = (body: ApiBody | undefined): boolean => body?.kind === 'json-undescribed';
  const live: string[] = [];
  for (const route of API_ROUTES) {
    const base = key(route.method, route.path);
    if ([route.request, ...(route.deprecatedRequests ?? [])].some(undescribed)) {
      live.push(`${base} request`);
    }
    for (const success of route.success) {
      if (undescribed(success.body)) live.push(`${base} ${String(success.status)}`);
    }
  }
  const frozen = new Set(UNDESCRIBED_BODIES);
  expect(
    live.filter((body) => !frozen.has(body)),
    'bodies with no contract schema; describe them in packages/contracts',
  ).toEqual([]);
  expect(
    UNDESCRIBED_BODIES.filter((body) => !live.includes(body)),
    'now described: delete these lines from UNDESCRIBED_BODIES',
  ).toEqual([]);
}

function assertOAuthAndCronExclusions(): void {
  const oauthOnly = API_ROUTE_EXCLUSIONS.filter((route) =>
    OAUTH_PROTOCOL_ROUTE.test(route.because),
  ).map((route) => key(route.method, route.path));
  expect(oauthOnly.sort()).toEqual(
    [
      'GET /.well-known/oauth-authorization-server',
      'GET /.well-known/oauth-protected-resource/mcp/projects/:name',
      'GET /.well-known/oauth-protected-resource/mcp/builder',
      'GET /.well-known/oauth-protected-resource/api/a2a/agents/:agentName',
      'POST /oauth/token',
      'POST /oauth/revoke',
    ].sort(),
  );
  const cronOnly = API_ROUTE_EXCLUSIONS.filter((route) => route.because === PLATFORM_CRON_JOB).map(
    (route) => key(route.method, route.path),
  );
  expect(cronOnly).toEqual([
    'GET /api/cron/retention',
    'GET /api/cron/triggers',
    'GET /api/cron/storage-cleanup',
  ]);
}

function assertPlatformOnlyExclusions(): void {
  const probeOnly = API_ROUTE_EXCLUSIONS.filter(
    (route) => route.because === PLATFORM_READINESS_PROBE,
  ).map((route) => key(route.method, route.path));
  expect(probeOnly).toEqual(['GET /api/readyz']);
  const runCallerOnly = API_ROUTE_EXCLUSIONS.filter(
    (route) => route.because === RUN_CALLER_ROUTE,
  ).map((route) => key(route.method, route.path));
  expect(runCallerOnly).toEqual(['POST /api/builder/mcp']);
  const leadRunOnly = API_ROUTE_EXCLUSIONS.filter((route) => route.because === LEAD_RUN_ROUTE).map(
    (route) => key(route.method, route.path),
  );
  expect(leadRunOnly).toEqual(['POST /api/runs/:id/members/mcp']);
}

function assertPrivateRunnerExclusions(): void {
  const runnerOnly = API_ROUTE_EXCLUSIONS.filter(
    (route) => route.because === PRIVATE_RUNNER_ROUTE,
  ).map((route) => key(route.method, route.path));
  // The ENG-06 state routes, the transcript writes and the run's file search: the running agent
  // (through `apps/runner`) is their only client.
  expect(runnerOnly.sort()).toEqual(
    [
      'GET /api/sessions/:engineSessionId/file-search',
      'POST /api/sessions/:engineSessionId/transcript',
      'DELETE /api/sessions/:engineSessionId/transcript',
      ...['GET', 'POST', 'PUT', 'DELETE'].map((method) =>
        key(method, '/api/sessions/:engineSessionId/state-entries'),
      ),
      'GET /api/sessions/:engineSessionId/state-streams',
      'GET /api/sessions/:engineSessionId/state-blobs',
      'PUT /api/sessions/:engineSessionId/state-blobs',
    ].sort(),
  );
}
