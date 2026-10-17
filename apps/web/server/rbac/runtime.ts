/**
 * The single seam between RBAC routes and two application boundaries: who the caller is
 * (`apps/web/server/auth/**`) and where users, memberships, API keys and invitations are stored.
 *
 * One module-global, one setter, one clearer, one reader, and nothing else — the same shape
 * `apps/web/server/agents/runtime.ts` uses, for the same reasons, including the one that was
 * measured rather than assumed: **Next.js compiles `instrumentation.ts` and the route handlers
 * into separate module graphs**, so a module-level `let` here is one variable per bundle and the
 * composition root's call would be invisible to the routes. The registry is a property of
 * `globalThis`, which every bundle in one Node process shares.
 *
 * ## Unconfigured fails, it does not fall through (ADR-0015)
 *
 * Until something calls {@link configureRbacRuntime}, every route of this task answers
 * `503 rbac_runtime_not_configured`. Not `401`, which would assert that the caller was checked;
 * not `200` with an empty list, which is what this bug usually looks like — an unconfigured
 * directory reads as "this workspace has no members", a green screen, and an authorisation
 * decision nobody made.
 *
 * The composition root installs the durable PostgreSQL adapter through `installRbacApi`. Tests
 * clear the registry deliberately to prove the unconfigured response remains fail-closed.
 */
import type { DirectoryRoot } from './directory';
import type { Principal } from './principal';

/** Everything this task's routes need from the rest of the application, and nothing more. */
export interface RbacRuntime {
  /**
   * Who is calling, or `null` when nothing about the request proves an identity.
   *
   * Implementations must derive the workspace and the role from a verified session cookie or a
   * verified API key, never from a header, query parameter or body field the caller controls.
   */
  identify(request: Request): Promise<Principal | null>;
  /** Users, memberships, API keys and invitations. */
  directory: DirectoryRoot;
}

/** Namespaced so the property cannot collide with anything else on the global object. */
interface RbacRuntimeRegistry {
  __agentWorkspaceRbacRuntime__?: RbacRuntime;
}

const registry = globalThis as typeof globalThis & RbacRuntimeRegistry;

/** Install the runtime. Called from application wiring, never from a request handler. */
export function configureRbacRuntime(runtime: RbacRuntime): void {
  registry.__agentWorkspaceRbacRuntime__ = runtime;
}

/** Remove it. Exists so a test can assert that the unconfigured path really fails. */
export function clearRbacRuntime(): void {
  // `delete`, not `= undefined`: an own property holding `undefined` and an absent property must
  // not be two different states for `currentRbacRuntime` to reason about.
  delete registry.__agentWorkspaceRbacRuntime__;
}

/** The installed runtime, or `null` when nothing has been wired yet. Never throws. */
export function currentRbacRuntime(): RbacRuntime | null {
  return registry.__agentWorkspaceRbacRuntime__ ?? null;
}
