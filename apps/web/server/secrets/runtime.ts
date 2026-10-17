/**
 * The single seam between the secrets routes and the rest of the application — who the caller is,
 * and where secrets are stored. Copies `apps/web/server/agents/runtime.ts`'s shape and reasoning
 * exactly; read that file's header for why a `globalThis`-anchored registry and not a module-level
 * `let` (Next.js compiles route handlers and `instrumentation.ts` into separate module graphs).
 *
 * ## The unconfigured case fails, it does not fall through (ADR-0015)
 *
 * Until something calls {@link configureSecretsRuntime}, {@link currentSecretsRuntime} returns
 * `null` and every secrets route answers `503 secrets_runtime_not_configured` — not `401`, because
 * nothing checked anything yet, and not `200` with an empty list, which would claim a capability
 * nobody configured.
 *
 * Wiring the real implementation into `apps/web/instrumentation.ts` (constructing
 * `@agent-workspace/core/secrets`'s `createSecretsService`, which needs the configured master-key
 * provider and `DATABASE_URL`, and calling {@link configureSecretsRuntime} with it) is **left to the
 * integrator** — `instrumentation.ts` is not in this task's `Owns:` globs, and every Wave 2
 * resource track needs the same composition-root wiring done in the same file
 * (the Wave 2 plan's sub-wave 2b runs five such tracks in parallel). Until that wiring
 * lands, every `/api/secrets/**` route in a real deployment answers 503 by name, which is the
 * correct, honest statement about a capability that exists in code and is not yet installed.
 */
import type { SecretsStoreProvider } from './store';

/**
 * Who the caller is, as far as the secrets routes need to know.
 *
 * The same shape `apps/web/server/agents/runtime.ts` declares as `WorkspaceResolution`, duplicated
 * here rather than imported. `apps/web/server/agents/**` is a sibling task's `Owns:` glob, not
 * this one's, and this task has no business depending on a file it cannot change; the shape is
 * three lines and worth keeping this module self-contained over.
 */
export type WorkspaceResolution =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'unauthenticated'; readonly reason: string }
  | { readonly kind: 'forbidden'; readonly reason: string };

/** Everything the secrets routes need from the rest of the application, and nothing more. */
export interface SecretsRuntime {
  /** Decide which workspace this request acts in (spec §25). Never derived from caller input. */
  resolveWorkspace(request: Request): Promise<WorkspaceResolution>;
  /** Secret metadata persistence, scoped to one workspace. Cannot produce a value — see `store.ts`. */
  secrets: SecretsStoreProvider;
}

interface SecretsRuntimeRegistry {
  __agentWorkspaceSecretsRuntime__?: SecretsRuntime;
}

const registry = globalThis as typeof globalThis & SecretsRuntimeRegistry;

/** Install the runtime the secrets routes use. Called once, from application wiring. */
export function configureSecretsRuntime(runtime: SecretsRuntime): void {
  registry.__agentWorkspaceSecretsRuntime__ = runtime;
}

/** Remove the installed runtime. Exists so a test can assert the unconfigured path really fails. */
export function clearSecretsRuntime(): void {
  delete registry.__agentWorkspaceSecretsRuntime__;
}

/** The installed runtime, or `null` when nothing has been wired yet. Never throws. */
export function currentSecretsRuntime(): SecretsRuntime | null {
  return registry.__agentWorkspaceSecretsRuntime__ ?? null;
}
