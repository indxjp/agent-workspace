/**
 * The seam between the skills routes and the two things this task does not own: who the caller is
 * (`apps/web/server/auth/**`, W1-CP-06) and an authorisation decision beyond "is there a session"
 * (W2-CP-06's RBAC layer). Shaped like `apps/web/server/files/runtime.ts` on purpose — same
 * unconfigured-fails-loud contract, same `globalThis` anchor, for the same reason that file's own
 * header gives: Next.js compiles route handlers and `instrumentation.ts` into separate module
 * graphs, so a plain module-level `let` here would not be one registry.
 *
 * `apps/web/instrumentation.ts` calls {@link configureSkillsRuntime} in a running deployment when
 * `AW_SKILL_STORAGE_ROOT` names the private root reserved for skills. It deliberately does not
 * reuse `AW_FILE_STORAGE_ROOT`: the files API accepts caller-chosen paths, so sharing a root would
 * make the platform-owned `skills/` and `skill-meta/` prefixes caller-addressable. The composition
 * root ADR records that separation. This task's route tests still configure the seam directly.
 *
 * ## The unconfigured case fails, it does not fall through (ADR-0015)
 *
 * Until something calls {@link configureSkillsRuntime}, {@link currentSkillsRuntime} returns
 * `null` and every route answers `503`. It does not answer `401` (nothing checked a session) and it
 * does not answer `200` with an empty list (an unconfigured store reading as "no skills" is a green
 * screen hiding a capability nobody verified).
 */
import type { WorkspaceSkillsStoreProvider } from './store';
import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';

/** Who the caller is, as far as the skills routes need to know. Mirrors `files/runtime.ts`'s. */
export type WorkspaceResolution =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'unauthenticated'; readonly reason: string }
  | { readonly kind: 'forbidden'; readonly reason: string };

/** Everything the skills routes need from the rest of the application. */
export interface SkillsRuntime {
  /**
   * Decide which workspace this request acts in (spec §25). Implementations must derive the
   * workspace from the authenticated session, never from a request header, query parameter, path
   * segment or body field the caller controls.
   */
  resolveWorkspace(request: Request): Promise<WorkspaceResolution>;
  /** Object storage for skills, keyed by workspace id. */
  store: WorkspaceSkillsStoreProvider;
  catalog?: ResourceCatalogStoreProvider;
}

interface SkillsRuntimeRegistry {
  __agentWorkspaceSkillsRuntime__?: SkillsRuntime;
}

const registry = globalThis as typeof globalThis & SkillsRuntimeRegistry;

/** Install the runtime the skills routes use. Called once, from application wiring. */
export function configureSkillsRuntime(runtime: SkillsRuntime): void {
  registry.__agentWorkspaceSkillsRuntime__ = runtime;
}

/** Remove the installed runtime. Exists so a test can assert the unconfigured path really fails. */
export function clearSkillsRuntime(): void {
  delete registry.__agentWorkspaceSkillsRuntime__;
}

/** The installed runtime, or `null` when nothing has been wired yet. Never throws. */
export function currentSkillsRuntime(): SkillsRuntime | null {
  return registry.__agentWorkspaceSkillsRuntime__ ?? null;
}
