/**
 * The single seam between RBAC routes and two application boundaries: who the caller is
 * (`apps/web/server/auth/**`) and where users, memberships, API keys and invitations are stored.
 *
 * The composition root builds it once and installs it as `ApplicationContext.rbac`
 * (`apps/web/server/application-context.ts`); a route reads `applicationContext()?.rbac` per request.
 *
 * ## Unconfigured fails, it does not fall through (ADR-0015)
 *
 * Until the composition root installs the application context, every route of this task answers
 * `503 rbac_runtime_not_configured`. Not `401`, which would assert that the caller was checked;
 * not `200` with an empty list, which is what this bug usually looks like — an unconfigured
 * directory reads as "this workspace has no members", a green screen, and an authorisation
 * decision nobody made.
 *
 * The composition root builds the durable PostgreSQL adapter through `installRbacApi`. Tests
 * clear the application context deliberately to prove the unconfigured response remains
 * fail-closed.
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
