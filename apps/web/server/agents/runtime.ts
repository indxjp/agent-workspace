/**
 * The single seam between the agent routes and the two things this task does not own: who the
 * caller is (W1-CP-06, `apps/web/server/auth/**`) and where agents are stored (a Postgres adapter,
 * which needs `@agent-workspace/core` in `apps/web/package.json` — outside this task's ownership;
 * see docs/adr/W1-CP-05-agents-api-has-no-core-dependency.md).
 *
 * A Next.js route handler is a bare exported function. There is no request-scoped container to
 * inject into, so the wiring has to reach the handler through module state. That is what this file
 * is: one module-global, one setter, one reader, and nothing else.
 *
 * ## The unconfigured case fails, it does not fall through (ADR-0015)
 *
 * Until something calls {@link configureAgentsRuntime}, {@link currentAgentsRuntime} returns
 * `null` and every route answers `503 agents_runtime_not_configured`. It does not answer `401`,
 * because answering `401` would assert that the caller was checked and found wanting, and nothing
 * checked anything. It does not answer `200` with an empty list either, which is the shape this
 * bug usually takes: an unconfigured store reads as "no agents", a green screen, and a capability
 * nobody verified. A check that cannot run fails, and says which check.
 *
 * ## Scope of the global, and why it is anchored on `globalThis`
 *
 * **Next.js compiles `instrumentation.ts` and the route handlers into separate module graphs**, so
 * a module-level `let` here is not one variable — it is one per bundle. W1-CP-04 hit this and moved
 * its own registry (`server/runs/environment.ts`) to `globalThis` for it; this module kept a
 * `let configured` because, at the time, nothing outside a test ever called
 * {@link configureAgentsRuntime}, so the two copies were never both live.
 *
 * W1-COMP-01 wrote the composition root that calls it, and measured the consequence on
 * `next@16.3.4`: `register()` logged `[compose] agent API installed`, and in the same process
 * `GET /api/agents` carrying a valid session answered
 *
 * ```text
 * HTTP/1.1 503 Service Unavailable
 * {"error":{"code":"agents_runtime_not_configured", …}}
 * ```
 *
 * while `GET /api/runs/:id` — whose registry is on `globalThis` — reached its adapters in the same
 * request cycle. A `globalThis` property is shared by every bundle in one Node process, so the two
 * halves see one runtime. See
 * `docs/adr/W1-CP-04-run-api-is-installed-not-imported.md`, which is the same finding, and
 * `docs/adr/W1-COMP-01-the-composition-root-and-what-it-does-not-wire.md`.
 *
 * The scope this buys is exactly one process. Deliberately not more: two replicas have two
 * runtimes, which is correct, because what is being registered is per-process wiring. It does not
 * survive a redeploy, which is also correct. Nothing per-request is ever stored here.
 */
import type { AgentStoreProvider } from './store';
import type { AgentResourceStoreProvider } from './resource-store';
import type { AgentGrantStoreProvider } from './agent-grants-store';
import type { CeilingFor } from '../policy-ceiling/ceiling';
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
   * agent. Absent when `AW_DEPLOYMENT_POLICY` is unset, and then those writes are unchanged.
   */
  ceilingFor?: CeilingFor;
  /** §36 sink for the one audit row written when an agent changes runtime profiles. */
  runtimeSwitchAudit?:
    | {
        record(
          request: Request,
          change: Readonly<{
            agentId: string;
            agentName: string;
            fromRuntimeProfileId: string | null;
            toRuntimeProfileId: string | null;
          }>,
        ): Promise<void>;
      }
    | undefined;
}

/** Namespaced so the property cannot collide with anything else on the global object. */
interface AgentsRuntimeRegistry {
  __agentWorkspaceAgentsRuntime__?: AgentsRuntime;
}

const registry = globalThis as typeof globalThis & AgentsRuntimeRegistry;

/**
 * Install the runtime the agent routes use. Called once, from application wiring — never from a
 * request handler, and never from a module that a route imports transitively for another reason.
 */
export function configureAgentsRuntime(runtime: AgentsRuntime): void {
  registry.__agentWorkspaceAgentsRuntime__ = runtime;
}

/** Remove the installed runtime. Exists so a test can assert the unconfigured path really fails. */
export function clearAgentsRuntime(): void {
  // `delete`, not `= undefined`: `currentAgentsRuntime` reads the property, and an own property
  // holding `undefined` and an absent property must not be two different states to reason about.
  delete registry.__agentWorkspaceAgentsRuntime__;
}

/** The installed runtime, or `null` when nothing has been wired yet. Never throws. */
export function currentAgentsRuntime(): AgentsRuntime | null {
  return registry.__agentWorkspaceAgentsRuntime__ ?? null;
}
