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
  // Issue #790 (ADR-0118 TS1): the content-addressed code-tool bundles `aw push` uploads.
  'tool-bundles',
  // Issue #236 (SDK-04, S-1). `POST /api/tokens` mints a browser token; see §21 of
  // `apps/web/server/rbac/permissions.ts`'s policy table for its grants.
  'tokens',
  'users',
  'workspaces',
] as const;

export type Resource = (typeof RESOURCES)[number];

export function parseResource(value: unknown): Resource | null {
  if (typeof value !== 'string') return null;
  return RESOURCES.find((resource) => resource === value) ?? null;
}
