/**
 * What `/api/workspaces/**` reads to reach persistence. `installRbacApi` builds it and the
 * composition root installs it as `ApplicationContext.workspaces`; with no context installed every
 * reader answers its own `503`.
 *
 * ## Why this is its own domain rather than a field the routes read off `rbac/runtime.ts`
 *
 * `RbacRuntime.directory` is workspace-scoped by the time a route sees it — `authorise()` opens it
 * with `.forWorkspace(principal.workspaceId)`, i.e. the caller's *session* workspace
 * (`apps/web/server/rbac/http.ts`). Every `/api/workspaces` route can legitimately act on a
 * *different* workspace than the session's own — that is the entire point of "list my other
 * memberships" and "open the one I switched to" — so the repository these routes need has to reach
 * any workspace by id, unscoped, which is exactly `DatabaseRoot.workspaces`'s shape
 * (`packages/core/src/db/repositories/workspaces.ts`) and not what `RbacRuntime.directory` hands
 * out. `requireResourceAccess` (`apps/web/server/resources/authorise.ts`) is still what these
 * routes use for authentication and for running `decide()`; this registry is only the extra
 * persistence handle that engine does not carry.
 */
import type { DatabaseRoot } from '@agent-workspace/core/db';

/** The one thing these routes need from `DatabaseRoot`, named so nothing else leaks in. */
export type WorkspaceRepositoryPort = DatabaseRoot['workspaces'];

export interface WorkspacesRuntime {
  readonly repository: WorkspaceRepositoryPort;
}
