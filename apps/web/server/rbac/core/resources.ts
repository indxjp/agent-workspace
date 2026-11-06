/** Top-level resources exposed under `/api/` and classified by the RBAC policy. */
export const RESOURCES = [
  'agents',
  'api-keys',
  'audit-events',
  'connectors',
  // Issue #949 (ADR-0134): the endpoint clients external platforms reach A2A agents and MCP
  // projects through, and the endpoint-scoped API keys bound to them.
  'endpoint-clients',
  // `/api/engines` — the engine catalogue this deployment offers. Issue #319 (ENG-02c); its
  // mandate is spec §5, which makes the engine an extension point behind one port (ADR-0065),
  // so which engines a deployment installs is a fact a client must be able to read.
  'engines',
  'files',
  'invitations',
  // `/api/me` — the caller's own principal. Issue #233 (SDK-01); its mandate is §21, which makes
  // the workspace-local identity and its role the thing every other decision is taken against.
  'me',
  'memberships',
  'metrics',
  'model-connections',
  'models',
  // `/api/platforms` — the external agent platforms an agent version can be exported to. Issue
  // #968 (ADR-0133); a catalogue like `engines`, readable by every role.
  'platforms',
  'projects',
  'runs',
  'runtime-connections',
  'runtime-profiles',
  'runtimes',
  'secrets',
  'sessions',
  'shares',
  'sharing-policies',
  'skills',
  'setup',
  // Issue #1690 (STO-503, US-STO-12): the buckets and folders a workspace connects; the storage
  // design §05. Credentials stay in the secret store, so a read discloses no secret.
  'storage-connections',
  // Issue #790 (ADR-0118 TS1): the content-addressed code-tool bundles `aw push` uploads.
  'tool-bundles',
  // Issue #236 (SDK-04, S-1). `POST /api/tokens` mints a browser token; see §21 of
  // `apps/web/server/rbac/core/permissions.ts`'s policy table for its grants.
  'tokens',
  // Issue #1293 (ADR-0144): inbound triggers — the URLs and schedules that start a run as their
  // owner. Managed like an endpoint client: credential-bearing configuration.
  'triggers',
  'users',
  // Issue #250 (N-3, ADR-SDK-18-N3-250 D6): the endpoints a workspace's run outcomes are posted
  // to. Deciding where run data goes is configuration like API keys, so Owner and Admin manage it.
  'webhooks',
  'workspaces',
] as const;

export type Resource = (typeof RESOURCES)[number];

export function parseResource(value: unknown): Resource | null {
  if (typeof value !== 'string') return null;
  return RESOURCES.find((resource) => resource === value) ?? null;
}

/**
 * Path segments that are authorised as another resource, and nothing else. `/api/agent-teams/**`
 * is decided as `agents` (ADR-0104 acceptance decision 10): reading a team is reading an agent,
 * and creating, versioning or deleting one is the same write as on an agent, so no new resource
 * and no new grants exist for it. A segment here is never itself a {@link Resource}.
 */
export const RESOURCE_ALIASES: Readonly<Record<string, Resource>> = { 'agent-teams': 'agents' };

/**
 * The resource the `/api/<segment>` path is decided as: the segment itself when it is one of
 * {@link RESOURCES}, its {@link RESOURCE_ALIASES} target, or `null` for anything else.
 */
export function resourceOfSegment(segment: unknown): Resource | null {
  const resource = parseResource(segment);
  if (resource !== null || typeof segment !== 'string') return resource;
  return Object.hasOwn(RESOURCE_ALIASES, segment) ? (RESOURCE_ALIASES[segment] ?? null) : null;
}
