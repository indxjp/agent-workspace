/**
 * The one object the composition root builds and every route handler reads its domain wiring
 * from (engineering audit F-10). Each `wire<Domain>` in `composition/wiring/**` returns its domain's
 * fully built runtime, the root collects them here once, and a route reads
 * `applicationContext()?.<domain>` instead of a per-domain `current<Domain>Runtime()` slot.
 *
 * It lives in one `defineSlot` for the reason `runtime-slot.ts` gives: Next.js compiles
 * `instrumentation.ts` and the route handlers into separate module graphs.
 *
 * `null` means the composition root installed nothing (no session secret, no reachable database),
 * and each domain's routes answer their own named `503` for it. What stays on its own slot is
 * process-local state rather than domain wiring (live-run handles, the driver and engine
 * registries, per-run telemetry attributes, the held composition, detection and cron caches).
 */
import type { A2a } from './a2a/env';
import type { AgentVersionsRuntime } from './agent-versions/runtime';
import type { AgentsRuntime } from './agents/runtime';
import type { AuditRuntime } from './audit/runtime';
import type { BuilderDoor } from './builder/transport/mcp';
import type { CliAuthRuntime } from './cli-auth/runtime';
import type { Connectors } from './connectors/runtime';
import type { EndpointClientsRuntime } from './endpoint-clients/runtime';
import type { Files } from './files/runtime';
import type { InvitationsRuntime } from './invitations/runtime';
import type { Models } from './models/runtime';
import type { OAuthRuntime } from './oauth/runtime';
import type { ProjectsRuntime } from './projects/runtime';
import type { RbacRuntime } from './rbac/runtime';
import { defineSlot } from './runtime-slot';
import type { RunApi } from './runs/environment';
import type { Runtimes } from './runtimes/runtime';
import type { Secrets } from './secrets/runtime';
import type { SessionApiEnvironment } from './sessions/environment';
import type { Setup } from './setup/runtime';
import type { SharesRuntime } from './shares/core/runtime';
import type { Skills } from './skills/runtime';
import type { StorageConnections } from './storage-connections/runtime';
import type { PublicSurfaces } from './surfaces/public/runtime';
import type { Tokens } from './tokens/runtime';
import type { ToolEndpoint } from './tool-endpoint/env';
import type { Triggers } from './triggers/runtime';
import type { WorkspaceFeaturesRuntime } from './workspaces/features-runtime';
import type { WorkspacesRuntime } from './workspaces/runtime';

/** Every domain the composition root has collected, each fully built. */
export interface ApplicationContext {
  readonly a2a: A2a;
  readonly agents: AgentsRuntime;
  readonly agentVersions: AgentVersionsRuntime;
  readonly audit: AuditRuntime;
  /** The `aw-control` door (`POST /api/builder/mcp`): who a run token acts for, and the Builder ports. */
  readonly builder: BuilderDoor;
  readonly cliAuth: CliAuthRuntime;
  readonly connectors: Connectors;
  readonly endpointClients: EndpointClientsRuntime;
  readonly files: Files;
  readonly invitations: InvitationsRuntime;
  readonly models: Models;
  readonly oauth: OAuthRuntime;
  readonly projects: ProjectsRuntime;
  readonly rbac: RbacRuntime;
  readonly runs: RunApi;
  readonly runtimes: Runtimes;
  readonly secrets: Secrets;
  readonly sessions: SessionApiEnvironment;
  readonly setup: Setup;
  readonly shares: SharesRuntime;
  readonly skills: Skills;
  readonly storageConnections: StorageConnections;
  readonly surfaces: PublicSurfaces;
  readonly tokens: Tokens;
  readonly toolEndpoint: ToolEndpoint;
  readonly triggers: Triggers;
  readonly workspaceFeatures: WorkspaceFeaturesRuntime;
  readonly workspaces: WorkspacesRuntime;
}

const slot = defineSlot<ApplicationContext>('__agentWorkspaceApplicationContext__');

/**
 * Install the context. Called once by the composition root, after every domain is built: a route
 * never sees a context whose run API, endpoints, tokens, triggers or surfaces are still to come.
 */
export function installApplicationContext(context: ApplicationContext): void {
  slot.set(context);
}

/** Remove the installed context, so a test can prove the unconfigured path fails. */
export function clearApplicationContext(): void {
  slot.clear();
}

/** The installed context, or `null` when nothing has been wired. Never throws. */
export function applicationContext(): ApplicationContext | null {
  return slot.current();
}
