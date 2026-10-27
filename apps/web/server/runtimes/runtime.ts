/**
 * The seam between the runtime-profile and runtime-connection routes and the rest of the
 * application (ADR-0015: the unconfigured case is a `503`, not a `401` or an empty `200`).
 *
 * The composition root (`installRuntimesApi` in `composition/services.ts`) builds it and installs it
 * as `ApplicationContext.runtimes`. Runtime connections are encrypted secrets, so it is
 * `unavailable` whenever the secrets service did not start; every `/api/runtime-profiles/**` and
 * `/api/runtime-connections/**` route then answers its named 503, as it does with no context.
 */
import type { RuntimeConnectionStoreProvider } from './connections';
import type { RuntimeProfileStoreProvider } from './store';

/**
 * Who the caller is, as far as these routes need to know. The same shape
 * `apps/web/server/agents/runtime.ts` declares as `WorkspaceResolution`, duplicated here rather
 * than imported: `apps/web/server/agents/**` is a sibling task's `Owns:` glob, and this task has
 * no business depending on a file it cannot change (see that file's own identical note about
 * `apps/web/server/secrets/runtime.ts`).
 */
export type WorkspaceResolution =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'unauthenticated'; readonly reason: string }
  | { readonly kind: 'forbidden'; readonly reason: string };

/** Everything the runtimes routes need from the rest of the application, and nothing more. */
export interface RuntimesRuntime {
  resolveWorkspace(request: Request): Promise<WorkspaceResolution>;
  /** Runtime-profile persistence, scoped to one workspace. */
  profiles: RuntimeProfileStoreProvider;
  /** Runtime-connection persistence, scoped to one workspace. */
  connections: RuntimeConnectionStoreProvider;
}

/** The runtimes routes as the application context holds them. */
export type Runtimes =
  | { readonly kind: 'serving'; readonly runtime: RuntimesRuntime }
  | { readonly kind: 'unavailable' };
