/**
 * The tool endpoint's persistence port — the one module of `apps/web/server/tool-endpoint` that
 * names `@agent-workspace/core/db` (F-08, W3-5). `sources.ts` depends on the type-only names
 * declared here; the composition root hands in the tenant-scoped providers, which satisfy them
 * structurally. Copies the shape of `../sessions/store.ts`.
 */
import type {
  AgentVersionRepositoryProvider,
  RuntimeProfileRepositoryProvider,
  WorkspaceScope,
} from '@agent-workspace/core/db';

/** The workspace every endpoint read is scoped to. */
export type { WorkspaceScope };

/** The agent-version reads the code-tool listing performs. */
export type EndpointAgentVersions = AgentVersionRepositoryProvider;

/** The runtime-profile reads a sandbox call performs. */
export type EndpointRuntimeProfiles = RuntimeProfileRepositoryProvider;
