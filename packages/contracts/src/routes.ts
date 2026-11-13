import { a2aRoutes } from './routes/a2a.js';
import { agentTeamsRoutes } from './routes/agentTeams.js';
import { agentsRoutes } from './routes/agents.js';
import { authRoutes } from './routes/auth.js';
import { connectorsRoutes } from './routes/connectors.js';
import { endpointClientsRoutes } from './routes/endpointClients.js';
import { enginesRoutes } from './routes/engines.js';
import { filesRoutes } from './routes/files.js';
import { mcpRoutes } from './routes/mcp.js';
import { meRoutes } from './routes/me.js';
import { modelsRoutes } from './routes/models.js';
import { observabilityRoutes } from './routes/observability.js';
import { platformsRoutes } from './routes/platforms.js';
import { projectsRoutes } from './routes/projects.js';
import { runsRoutes } from './routes/runs.js';
import { runtimesRoutes } from './routes/runtimes.js';
import { secretsRoutes } from './routes/secrets.js';
import { sessionsRoutes } from './routes/sessions.js';
import { sharesRoutes } from './routes/shares.js';
import { skillsRoutes } from './routes/skills.js';
import { storageConnectionRoutes } from './routes/storage-connections.js';
import { teamRoutes } from './routes/team.js';
import { tokensRoutes } from './routes/tokens.js';
import { toolBundleRoutes } from './routes/tool-bundles.js';
import { triggersRoutes } from './routes/triggers.js';
import { webhooksRoutes } from './routes/webhooks.js';
import { workspaceSelectionRoutes } from './routes/workspace-selection.js';
import { workspacesRoutes } from './routes/workspaces.js';
export type {
  ApiBody,
  ApiMultipartPart,
  ApiRequestHeader,
  ApiRoute,
  ApiRouteMethod,
  ApiRouteSecurity,
  ApiSchemaName,
  ApiSuccess,
} from './routes/definition.js';
export { API_SCHEMAS } from './routes/schemas.js';

import { type RouteFeature } from './features.js';
import { type ApiRoute, type ApiRouteMethod } from './routes/definition.js';

/**
 * Declared routes that are not part of the programmatic surface, and why. Two kinds (ADR-0080):
 *
 * - browser journeys — spec 04 §1 puts first-run setup, OIDC sign-in and the public share pages
 *   permanently out of scope;
 * - private runner routes — the transcript writes and the ENG-06 engine-state routes, which only
 *   `apps/runner` calls, with the signed per-run token rather than a workspace credential
 *   (`apps/web/server/sessions/state-api.ts`; 04 §5.11: runtime-only, not exposed by the SDK).
 *
 * The platform's own callers sit beside them: the cron jobs (`CRON_SECRET` bearer, ADR-0120) and
 * the readiness probe a kubelet calls with no credential (issue #1562). The `aw-control` MCP door a
 * running agent reaches through the gateway (issue #1846) accepts only a run token, as a `run-caller`.
 */
export const API_ROUTE_EXCLUSIONS: readonly {
  readonly method: ApiRouteMethod;
  readonly path: string;
  readonly feature: RouteFeature;
  readonly because: string;
}[] = [
  { method: 'POST', path: '/api/setup', feature: 'core', because: 'first-run setup (04 §1)' },
  { method: 'GET', path: '/api/auth/login', feature: 'core', because: 'OIDC sign-in (04 §1)' },
  { method: 'POST', path: '/api/auth/callback', feature: 'core', because: 'OIDC sign-in (04 §1)' },
  {
    method: 'GET',
    path: '/api/auth/workspace',
    feature: 'core',
    because: 'the HTML workspace-selection step of OIDC sign-in (04 §1)',
  },
  {
    method: 'GET',
    path: '/api/auth/cli-verify',
    feature: 'core',
    because: "the HTML page approving `aw login`'s code, a browser sign-in step (04 §1)",
  },
  {
    method: 'POST',
    path: '/api/auth/cli-verify',
    feature: 'core',
    because: "the form post approving `aw login`'s code, a browser sign-in step (04 §1)",
  },
  {
    method: 'GET',
    path: '/api/cron/retention',
    feature: 'core',
    because: 'platform cron job (CRON_SECRET bearer)',
  },
  {
    method: 'GET',
    path: '/api/cron/triggers',
    feature: 'triggers',
    because: 'platform cron job (CRON_SECRET bearer)',
  },
  {
    method: 'GET',
    path: '/api/cron/storage-cleanup',
    feature: 'core',
    because: 'platform cron job (CRON_SECRET bearer)',
  },
  {
    method: 'GET',
    path: '/api/readyz',
    feature: 'core',
    because: 'platform readiness probe (no credential)',
  },
  {
    method: 'POST',
    path: '/api/builder/mcp',
    feature: 'builder',
    because: 'run-caller route (per-run token, aw-control tools)',
  },
  {
    method: 'POST',
    path: '/api/runs/:id/members/mcp',
    feature: 'core',
    because: "lead-run route (the lead run's own token, agent-team member tools; ADR-0104)",
  },
  { method: 'GET', path: '/p/:token', feature: 'sharing', because: 'a public share page (04 §1)' },
  {
    method: 'POST',
    path: '/p/:token/messages',
    feature: 'sharing',
    because: 'a public share page (04 §1)',
  },
  {
    method: 'GET',
    path: '/p/s/:name',
    feature: 'surfaces',
    because: 'a hosted surface page (04 §1)',
  },
  {
    method: 'POST',
    path: '/p/s/:name/sessions',
    feature: 'surfaces',
    because:
      "the hosted surface's session bootstrap: loopback, or an anonymous visitor from the surface's allowed origins (04 §1)",
  },
  {
    method: 'GET',
    path: '/p/s/:name/widget.js',
    feature: 'surfaces',
    because: 'the hosted surface widget loader (04 §1)',
  },
  {
    method: 'GET',
    path: '/p/s/:name/try',
    feature: 'surfaces',
    because: 'the hosted surface try page (04 §1)',
  },
  {
    method: 'POST',
    path: '/api/sessions/:engineSessionId/transcript',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'DELETE',
    path: '/api/sessions/:engineSessionId/transcript',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/state-entries',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'POST',
    path: '/api/sessions/:engineSessionId/state-entries',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'PUT',
    path: '/api/sessions/:engineSessionId/state-entries',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'DELETE',
    path: '/api/sessions/:engineSessionId/state-entries',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/file-search',
    feature: 'files',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/state-streams',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'GET',
    path: '/api/sessions/:engineSessionId/state-blobs',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'PUT',
    path: '/api/sessions/:engineSessionId/state-blobs',
    feature: 'core',
    because: 'private runner route (per-run token)',
  },
  {
    method: 'GET',
    path: '/.well-known/oauth-authorization-server',
    feature: 'core',
    because: 'OAuth 2.0 authorization server metadata (RFC 8414), a public discovery document',
  },
  {
    method: 'GET',
    path: '/.well-known/oauth-protected-resource/mcp/projects/:name',
    feature: 'projects',
    because: 'OAuth protected resource metadata (RFC 9728), a public discovery document',
  },
  {
    method: 'GET',
    path: '/.well-known/oauth-protected-resource/mcp/builder',
    feature: 'builder',
    because: 'OAuth protected resource metadata (RFC 9728), a public discovery document',
  },
  {
    method: 'GET',
    path: '/.well-known/oauth-protected-resource/api/a2a/agents/:agentName',
    feature: 'core',
    because: 'OAuth protected resource metadata (RFC 9728), a public discovery document',
  },
  {
    method: 'GET',
    path: '/oauth/authorize',
    feature: 'core',
    because:
      'the HTML consent page of the OAuth authorization code grant, a browser sign-in step (04 §1)',
  },
  {
    method: 'POST',
    path: '/oauth/authorize',
    feature: 'core',
    because:
      'the consent form post of the OAuth authorization code grant, a browser sign-in step (04 §1)',
  },
  {
    method: 'POST',
    path: '/oauth/token',
    feature: 'core',
    because:
      'the OAuth token endpoint (RFC 6749), form-encoded and authenticated by the client secret or the grant, not by a workspace credential',
  },
  {
    method: 'POST',
    path: '/oauth/revoke',
    feature: 'core',
    because:
      'the OAuth token revocation endpoint (RFC 7009), form-encoded and authenticated by the client',
  },
];
/** The catalogue, grouped by family in the order of spec 04 §5. */
export const API_ROUTES: readonly ApiRoute[] = [
  ...meRoutes,
  ...workspacesRoutes,
  ...authRoutes,
  ...workspaceSelectionRoutes,
  ...tokensRoutes,
  ...teamRoutes,
  ...endpointClientsRoutes,
  ...triggersRoutes,
  ...webhooksRoutes,
  ...modelsRoutes,
  ...runtimesRoutes,
  ...storageConnectionRoutes,
  ...secretsRoutes,
  ...filesRoutes,
  ...skillsRoutes,
  ...toolBundleRoutes,
  ...connectorsRoutes,
  ...agentsRoutes,
  ...agentTeamsRoutes,
  ...projectsRoutes,
  ...sessionsRoutes,
  ...runsRoutes,
  ...sharesRoutes,
  ...observabilityRoutes,
  ...enginesRoutes,
  ...platformsRoutes,
  ...a2aRoutes,
  ...mcpRoutes,
];
