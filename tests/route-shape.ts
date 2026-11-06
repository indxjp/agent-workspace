// Fixed setup, identity, cron, MCP and A2A protocol endpoints do not name REST collections.
// Exact membership keeps their exceptions from admitting neighboring routes.
const PROTOCOL_ROUTE_PATHS = new Set([
  '/api/setup/runtime-detect',
  '/api/setup',
  '/api/auth/login',
  '/api/auth/callback',
  '/api/auth/workspace',
  '/api/auth/cli-device',
  '/api/auth/cli-verify',
  '/api/auth/cli-token',
  '/api/auth/cli-workspace',
  '/api/auth/token-exchange',
  '/api/cron/retention',
  '/api/cron/triggers',
  '/api/cron/storage-cleanup',
  '/api/readyz',
  '/api/builder/mcp',
  '/api/me',
  '/api/a2a/agents/:agentName',
  '/api/a2a/agents/:agentName/.well-known/agent-card.json',
  '/.well-known/oauth-protected-resource/api/a2a/agents/:agentName',
  '/mcp/builder',
  '/.well-known/oauth-protected-resource/mcp/builder',
  '/api/files/search',
  '/api/triggers/:id/fire/:secret',
  '/api/runs/:id/members/mcp',
]);

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const PARAMETER = /^:[a-z][A-Za-z0-9]*$/;

const ACTION_WORDS = new Set([
  'create',
  'creates',
  'get',
  'gets',
  'list',
  'lists',
  'update',
  'updates',
  'delete',
  'deletes',
  'remove',
  'removes',
  'rename',
  'renames',
  'move',
  'moves',
  'copy',
  'copies',
  'search',
  'searches',
  'execute',
  'executes',
  'revoke',
  'revokes',
  'import',
  'imports',
  'export',
  'exports',
  'upload',
  'uploads',
  'download',
  'downloads',
  'invite',
  'invites',
  'reset',
  'resets',
  'send',
  'sends',
]);

type ShapeVerdict =
  { readonly ok: true } | { readonly ok: false; readonly rule: string; readonly detail: string };

export function routeShape(routePathValue: string, printedInSpec: boolean): ShapeVerdict {
  // Spec §30's pre-authentication setup flow needs one read-only capability probe before any
  // resource or administrator exists. The exact path is dispatched by W7-UI-04; this narrow
  // exception does not generalise a second literal segment to any other API route.
  if (PROTOCOL_ROUTE_PATHS.has(routePathValue)) return { ok: true };

  if (!routePathValue.startsWith('/api/')) {
    if (printedInSpec) return { ok: true };
    return {
      ok: false,
      rule: 'outside-api',
      detail:
        `"${routePathValue}" is neither under /api/ nor printed in spec §34. §34 keeps the public ` +
        `pages under /p/ so that authentication is answerable from the path prefix alone; a new ` +
        `prefix is a specification change, not a route.`,
    };
  }
  const segments = routePathValue.slice(1).split('/');
  const [, resource, ...rest] = segments;
  if (resource === undefined || !SEGMENT.test(resource)) {
    return {
      ok: false,
      rule: 'shape',
      detail:
        `"${routePathValue}" does not begin /api/<resource>, where <resource> is lower-case words ` +
        `joined by single hyphens. ADR-0026 decision 3.`,
    };
  }
  if (rest.length > 2) {
    return {
      ok: false,
      rule: 'shape',
      detail:
        `"${routePathValue}" is deeper than /api/<resource>/:id/<sub>. §34 exposes "a very small ` +
        `control-plane API"; a fourth level is a resource that has not been named.`,
    };
  }
  if (rest.length >= 1 && !PARAMETER.test(rest[0] as string)) {
    return {
      ok: false,
      rule: 'shape',
      detail:
        `"${routePathValue}": the segment after the resource must be a dynamic id such as ":id", ` +
        `not "${rest[0] as string}". A second literal segment is a second resource.`,
    };
  }
  if (rest.length === 2 && !SEGMENT.test(rest[1] as string)) {
    return {
      ok: false,
      rule: 'shape',
      detail: `"${routePathValue}": "${rest[1] as string}" is not a lower-case hyphenated segment.`,
    };
  }
  if (!resource.endsWith('s')) {
    return {
      ok: false,
      rule: 'plural-resource',
      detail:
        `"${routePathValue}": the resource "${resource}" is not plural. Every resource §34 prints ` +
        `is — agents, runs, sessions, models, skills, connectors, files, users, projects, shares.`,
    };
  }
  if (ACTION_WORDS.has(resource)) {
    return {
      ok: false,
      rule: 'no-verb',
      detail:
        `"${routePathValue}": "${resource}" is an action, not a resource. §34 says "do not invent ` +
        `RPC frameworks if ordinary HTTP is enough" — the verb belongs in the method.`,
    };
  }
  return { ok: true };
}
