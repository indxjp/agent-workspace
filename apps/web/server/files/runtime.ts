/**
 * The seam between the files routes and the two things this task does not own: who the caller is
 * (`apps/web/server/auth/**`, W1-CP-06) and, later, an authorisation decision beyond "is there a
 * session" (W2-CP-06's RBAC layer). Shaped like `apps/web/server/agents/runtime.ts` on purpose —
 * same unconfigured-fails-loud contract, same `globalThis` anchor, for the same reason that file's
 * own header gives: Next.js compiles route handlers and `instrumentation.ts` into separate module
 * graphs, so a plain module-level `let` here would not be one registry.
 *
 * `apps/web/instrumentation.ts` is what would call {@link configureFilesRuntime} in a running
 * deployment. That file is W2-DB-02's (the Wave 2 plan's 2a row), not this task's, so no
 * call to {@link configureFilesRuntime} exists yet anywhere in the tracked tree — every files route
 * in this PR answers `503 files_runtime_not_configured` in the running app, on purpose, until an
 * integration-level change wires this up next to `configureAgentsRuntime`. That is a declared gap,
 * not an oversight: this task's own tests call {@link configureFilesRuntime} directly, the same way
 * `apps/web/server/agents/http.test.ts` does for the agents runtime.
 *
 * ## The unconfigured case fails, it does not fall through (ADR-0015)
 *
 * Until something calls {@link configureFilesRuntime}, {@link currentFilesRuntime} returns `null`
 * and every route answers `503`. It does not answer `401` (nothing checked a session) and it does
 * not answer `200` with an empty tree (an unconfigured store reading as "no files" is a green
 * screen hiding a capability nobody verified).
 */
import type { WorkspaceObjectStoreProvider } from './store';
import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';

/** Who the caller is, as far as the files routes need to know. Mirrors `agents/runtime.ts`'s. */
export type WorkspaceResolution =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'unauthenticated'; readonly reason: string }
  | { readonly kind: 'forbidden'; readonly reason: string };

/** Everything the files routes need from the rest of the application. */
export interface FilesRuntime {
  /**
   * Decide which workspace this request acts in (spec §25). Implementations must derive the
   * workspace from the authenticated session, never from a request header, query parameter, path
   * segment or body field the caller controls.
   */
  resolveWorkspace(request: Request): Promise<WorkspaceResolution>;
  /** Object storage, keyed by workspace id. */
  store: WorkspaceObjectStoreProvider;
  catalog?: ResourceCatalogStoreProvider;
}

interface FilesRuntimeRegistry {
  __agentWorkspaceFilesRuntime__?: FilesRuntime;
}

const registry = globalThis as typeof globalThis & FilesRuntimeRegistry;

/** Install the runtime the files routes use. Called once, from application wiring. */
export function configureFilesRuntime(runtime: FilesRuntime): void {
  registry.__agentWorkspaceFilesRuntime__ = runtime;
}

/** Remove the installed runtime. Exists so a test can assert the unconfigured path really fails. */
export function clearFilesRuntime(): void {
  delete registry.__agentWorkspaceFilesRuntime__;
}

/** The installed runtime, or `null` when nothing has been wired yet. Never throws. */
export function currentFilesRuntime(): FilesRuntime | null {
  return registry.__agentWorkspaceFilesRuntime__ ?? null;
}
