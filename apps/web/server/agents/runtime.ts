/**
 * The single seam between the agent routes and the two things this task does not own: who the
 * caller is (W1-CP-06, `apps/web/server/auth/**`) and where agents are stored (a Postgres adapter,
 * which needs `@agent-workspace/core` in `apps/web/package.json` — outside this task's ownership;
 * see docs/adr/W1-CP-05-agents-api-has-no-core-dependency.md).
 *
 * The composition root builds it once and installs it as `ApplicationContext.agents`; a route
 * reads `applicationContext()?.agents` per request.
 *
 * ## The unconfigured case fails, it does not fall through (ADR-0015)
 *
 * With no application context installed every route answers `503 agents_runtime_not_configured`.
 * It does not answer `401`, because answering `401` would assert that the caller was checked and
 * found wanting, and nothing checked anything. It does not answer `200` with an empty list either,
 * which is the shape this bug usually takes: an unconfigured store reads as "no agents", a green
 * screen, and a capability nobody verified. A check that cannot run fails, and says which check.
 */
import type { AgentStoreProvider } from './store';
import type { AgentResourceStoreProvider } from './resource-store';
import type { AgentGrantStoreProvider } from './agent-grants-store';
import type { DeploymentCeiling } from '../policy-ceiling/ceiling';
import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';

/**
 * Who the caller is, as far as the agent routes need to know.
 *
 * The three cases are exhaustive on purpose. `unauthenticated` and `forbidden` are separated
 * because they map to different statuses and because collapsing them would let a future resolver
 * express "I could not tell" as "not logged in", which is a guess wearing an answer's clothes.
 */
export type WorkspaceResolution =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'unauthenticated'; readonly reason: string }
  | { readonly kind: 'forbidden'; readonly reason: string };

/** Everything the agent routes need from the rest of the application, and nothing more. */
export interface AgentsRuntime {
  /**
   * Decide which workspace this request acts in (spec §25). Implementations must derive the
   * workspace from the authenticated session, never from a request header, query parameter or
   * body field the caller controls.
   */
  resolveWorkspace(request: Request): Promise<WorkspaceResolution>;
  /** Agent persistence, scoped to one workspace. */
  agents: AgentStoreProvider;
  /** Durable file, skill and connector assignments for each agent. */
  agentResources?: AgentResourceStoreProvider;
  /**
   * S-13: the id → name / enabled map `GET`/`PUT /api/agents/:id/policy` resolve a skill
   * allowlist through — the same catalog `apps/web/server/compose/resource-loader.ts` reads for a
   * run. `undefined` until a composition root wires it, in which case both policy routes answer
   * `503 agent_policy_not_configured`.
   */
  skillCatalog?: ResourceCatalogStoreProvider;
  /**
   * `agent_grants` — a Viewer's explicit "run this agent" grants (spec §21, issue #117).
   * `undefined` until a composition root wires it; `POST /api/agents/:id/runs`'s ownership
   * resolver treats that as "no grant" rather than as a 503, because every other role's checks
   * do not depend on it (`run-ownership.ts` is the one caller).
   */
  agentGrants?: AgentGrantStoreProvider;
  /**
   * The agent first-run setup most recently configured and tested in this workspace, or `null`
   * (PR #403 review; `agents.setup_configured_at`). The composer selects it before the user chooses
   * one, and still reads it only from the agents it was given, so it is never a way in.
   */
  setupAgentId?: (workspaceId: string) => Promise<string | null>;
  /**
   * The deployment's policy ceiling (issue #535), judged by every legacy write that could widen an
   * agent. `disabled` only when `AW_DEPLOYMENT_POLICY` is unset, and then those writes are unchanged.
   */
  readonly ceiling: DeploymentCeiling;
  /**
   * §36 sink for the one audit row written when an agent changes runtime profiles. `null` when the
   * runtimes API is not installed; a runtime switch then answers `503`.
   */
  readonly runtimeSwitchAudit: {
    record(
      request: Request,
      change: Readonly<{
        agentId: string;
        agentName: string;
        fromRuntimeProfileId: string | null;
        toRuntimeProfileId: string | null;
      }>,
    ): Promise<void>;
  } | null;
}
