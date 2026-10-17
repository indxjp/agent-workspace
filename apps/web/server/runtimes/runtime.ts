/**
 * The single seam between the runtime-profile and runtime-connection routes and the rest of the
 * application. Copies `apps/web/server/agents/runtime.ts`'s shape exactly — read that file's
 * header for why a `globalThis`-anchored registry (Next.js compiles route handlers and
 * `instrumentation.ts` into separate module graphs) and why the unconfigured case is a `503`, not
 * a `401` or an empty `200` (ADR-0015).
 *
 * ## What the integrator must call
 *
 * `apps/web/instrumentation.ts` is not in this task's `Owns:` globs. Wiring the real
 * implementation — constructing a `RuntimeProfileStoreProvider` over `openDatabaseRoot()`'s new
 * `.runtimeProfiles` and `.scopes` fields (added by this task to
 * `packages/core/src/db/repositories/root.ts`, declared outside this task's `Owns` cell in its PR
 * body) and a `RuntimeConnectionStoreProvider` over a `SecretsService` — and calling
 * {@link configureRuntimesRuntime} with both is left to the integrator, exactly as
 * `apps/web/server/secrets/runtime.ts` already documents for its own seam. The exact call this ADR
 * names, corrected at W3-CP-06-B1 — round 1's version did not compile (`connections.ts`'s port took
 * `scope: unknown` and called `scopeFor` eagerly and synchronously, but the only source of a real
 * `WorkspaceScope` is async). This shape is pasted here after being watched compiling and, driven
 * end to end (POST then GET) through a real, encrypting `SecretsService` and a real
 * `WorkspaceScopeResolver`, working — see `connections.test.ts`'s "W3-CP-06-B1" suite and this
 * task's PR report for the pasted commands and their output.
 *
 * ```ts
 * configureRuntimesRuntime({
 *   resolveWorkspace: /* the same resolver every other seam uses *\/,
 *   profiles: createRepositoryRuntimeProfileStoreProvider({
 *     repositories: root.runtimeProfiles,
 *     scopes: root.scopes,
 *   }),
 *   connections: createSecretsRuntimeConnectionStoreProvider({
 *     secrets: secretsService,
 *     scopes: root.scopes,
 *   }),
 * });
 * ```
 *
 * `secretsService` is the `SecretsService` `apps/web/server/secrets/runtime.ts`'s own integrator
 * call already builds (`createSecretsService`, from `@agent-workspace/core/secrets`) — the same
 * value, not a second one. It satisfies `RuntimeConnectionSecretsPort` structurally, with no adapter
 * of its own: `SecretsService.list`/`.create` already take a `WorkspaceScope` and return
 * `SecretMetadata`, a superset of the three fields the port reads. `root.scopes` is the same
 * `WorkspaceScopeResolver` the profiles half of this call already uses.
 *
 * Until that call happens, every `/api/runtime-profiles/**` and `/api/runtime-connections/**`
 * route in a real deployment answers 503 by name — the correct, honest statement about a
 * capability that exists in code and is not yet installed.
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

interface RuntimesRuntimeRegistry {
  __agentWorkspaceRuntimesRuntime__?: RuntimesRuntime;
}

const registry = globalThis as typeof globalThis & RuntimesRuntimeRegistry;

/** Install the runtime these routes use. Called once, from application wiring. */
export function configureRuntimesRuntime(runtime: RuntimesRuntime): void {
  registry.__agentWorkspaceRuntimesRuntime__ = runtime;
}

/** Remove the installed runtime. Exists so a test can assert the unconfigured path really fails. */
export function clearRuntimesRuntime(): void {
  delete registry.__agentWorkspaceRuntimesRuntime__;
}

/** The installed runtime, or `null` when nothing has been wired yet. Never throws. */
export function currentRuntimesRuntime(): RuntimesRuntime | null {
  return registry.__agentWorkspaceRuntimesRuntime__ ?? null;
}
