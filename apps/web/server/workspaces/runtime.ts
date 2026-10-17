/**
 * The registry `/api/workspaces/**` reads to reach persistence — the same `globalThis` shape
 * `apps/web/server/rbac/runtime.ts` and `apps/web/server/agents/runtime.ts` use, for the identical
 * reason both record: **Next.js compiles `instrumentation.ts` and the route handlers into separate
 * module graphs**, so a module-level `let` here would be one variable per bundle and the
 * composition root's {@link configureWorkspacesRuntime} call would be invisible to the routes. A
 * property on `globalThis` is shared by every bundle in one Node process.
 *
 * ## Why this is its own registry rather than a field the routes read off `rbac/runtime.ts`
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
import { defineSlot } from '../runtime-slot';

/** The one thing these routes need from `DatabaseRoot`, named so nothing else leaks in. */
export type WorkspaceRepositoryPort = DatabaseRoot['workspaces'];

export interface WorkspacesRuntime {
  readonly repository: WorkspaceRepositoryPort;
}

const slot = defineSlot<WorkspacesRuntime>('__agentWorkspaceWorkspacesRuntime__');

/** Install the runtime. Called from the composition root, never from a request handler. */
export function configureWorkspacesRuntime(runtime: WorkspacesRuntime): void {
  slot.set(runtime);
}

/** Remove it. Exists so a test can assert that the unconfigured path really fails. */
export function clearWorkspacesRuntime(): void {
  slot.clear();
}

/** The installed runtime, or `null` when nothing has been wired yet. Never throws. */
export function currentWorkspacesRuntime(): WorkspacesRuntime | null {
  return slot.current();
}
