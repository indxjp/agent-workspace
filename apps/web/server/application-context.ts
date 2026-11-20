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
import type { AgentTeamsRuntime } from './agent-teams/wiring';
import type { AgentVersionsRuntime } from './agent-versions/wiring';
import type { AgentsRuntime } from './agents/wiring';
import type { AuditRuntime } from './audit/wiring';
import type { BuilderDoor } from './builder/transport/mcp';
import type { CliAuthRuntime } from './cli-auth/wiring';
import type { DemoOperatorRuntime } from './demo/operator';
import type { Connectors } from './connectors/wiring';
import type { EmailLinkRuntime } from './email-link/transport/routes';
import type { EndpointClientsRuntime } from './endpoint-clients/wiring';
import type { Files } from './files/wiring';
import type { InvitationsRuntime } from './invitations/wiring';
import type { Models } from './models/wiring';
import type { OAuthRuntime } from './oauth/wiring';
import type { ProjectsRuntime } from './projects/wiring';
import type { RbacRuntime } from './rbac/wiring';
import { defineSlot } from './runtime-slot';
import type { RunApi } from './runs/environment';
import type { Runtimes } from './runtimes/wiring';
import type { Secrets } from './secrets/wiring';
import type { SessionApiEnvironment } from './sessions/environment';
import type { StoreRuntime } from './demo/storefront/transport/routes';
import type { Setup } from './setup/wiring';
import type { SharesRuntime } from './shares/wiring';
import type { Skills } from './skills/wiring';
import type { StorageConnections } from './storage-connections/wiring';
import type { PublicSurfaces } from './surfaces/public/wiring';
import type { Tokens } from './tokens/wiring';
import type { ToolEndpoint } from './tool-endpoint/env';
import type { Triggers } from './triggers/wiring';
import type { Webhooks } from './webhooks/wiring';
import type { WorkspaceFeaturesRuntime } from './workspaces/features-runtime';
import type { WorkspacesRuntime } from './workspaces/wiring';

/** Every domain the composition root has collected, each fully built. */
export interface ApplicationContext {
  readonly a2a: A2a;
  /** Agent teams (ADR-0104 acceptance, issue #1516): the team repository and its audit trail. */
  readonly agentTeams: AgentTeamsRuntime;
  readonly agents: AgentsRuntime;
  readonly agentVersions: AgentVersionsRuntime;
  readonly audit: AuditRuntime;
  /** The `aw-control` door (`POST /api/builder/mcp`): who a run token acts for, and the Builder ports. */
  readonly builder: BuilderDoor;
  readonly cliAuth: CliAuthRuntime;
  readonly connectors: Connectors;
  /**
   * The demo operator routes (`/api/demo/templates`, `/api/demo/verification`, `/api/demo/maintenance`,
   * `/api/demo/readiness`)
   * and the store's read of the maintenance verdicts (`/api/store/demos`).
   */
  readonly demoOperator: DemoOperatorRuntime;
  /** Email-link sign-in (`/api/auth/email-link`): `unavailable` with no database or session secret. */
  readonly emailLink: EmailLinkRuntime;
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
  /** The Agent Store's lead form, privacy facts and demo allowance (`/api/store/*`, `/api/demo/allowance`). */
  readonly store: StoreRuntime;
  readonly surfaces: PublicSurfaces;
  readonly tokens: Tokens;
  readonly toolEndpoint: ToolEndpoint;
  readonly triggers: Triggers;
  /** Run-outcome webhooks (N-3, ADR-SDK-18-N3-250): `unavailable` with no secrets service. */
  readonly webhooks: Webhooks;
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
