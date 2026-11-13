/**
 * Whether the shell should stop rendering and send the browser back to sign-in — issue #120's "a
 * removed or archived current workspace offers a route back to selection", the half of it only
 * `(shell)/layout.tsx` can catch: it runs before any child page's own `fetch` does, on every full
 * navigation, so a caller whose membership is gone never sees a page it may no longer read even
 * once (the card's verifier attack 2: "not left on a page whose data it may no longer read").
 *
 * `apps/web/proxy.ts`'s page-surface gate only verifies the session token's signature and expiry;
 * it never re-checks membership. `resolveIdentity` (`server/features/console.ts`) does, by
 * re-reading `membershipsForUser` fresh — but it returns `null` for two different reasons that
 * must not be treated alike: the caller's membership in the session's own workspace is genuinely
 * gone (a removal, or the session naming a workspace that no longer exists), or the RBAC runtime
 * itself is not wired at all — `apps/web/server/rbac/runtime.ts`'s own declared gap, belonging to a
 * different task. Redirecting for the second reason would turn an unrelated, already-declared gap
 * into every shell page redirecting in a loop; this function is the positive check (ADR-0015) that
 * tells the two apart before recommending either.
 */
import type { WorkspacesProblem } from './workspaces-directory';

export function shouldRecoverSession(input: {
  /** Whether `getSession()` verified a session token at all. */
  readonly hasSession: boolean;
  /** Whether `resolveIdentity(session)` resolved the caller's name, workspace and role. */
  readonly identityResolved: boolean;
  /** Whether a directory is actually wired in — `applicationContext() !== null`. */
  readonly runtimeConfigured: boolean;
}): boolean {
  if (!input.hasSession) return false;
  if (input.identityResolved) return false;
  if (!input.runtimeConfigured) return false;
  return true;
}

/**
 * Where recovery sends the browser, and why: the exact vocabulary
 * `apps/web/app/api/auth/workspace/route.ts`'s own stale-selection branch already redirects to
 * (`?error=session_expired`, which `apps/web/app/signin/page.tsx` renders as "That sign-in attempt
 * expired. Start again.") — one explanation for one underlying condition, not a second one this
 * task invents for the same fact.
 */
export const SESSION_RECOVERY_PATH = '/signin?error=session_expired';

/**
 * The three observable actions that make recovery fail closed. Clearing React state prevents a
 * delayed render from retaining tenant records, concealing the document closes the interval before
 * navigation commits, and navigation obtains a fresh identity. Keeping them explicit makes the
 * whole transition mutation-testable without a DOM test environment.
 */
export interface WorkspaceSessionRecoveryActions {
  readonly clearTenantState: () => void;
  readonly concealTenantDocument: () => void;
  readonly navigate: (path: string) => void;
}

/**
 * A stale current-workspace session can be exposed while the already-open shell refreshes the
 * directory, before a new Server Component navigation gives `layout.tsx` a chance to redirect.
 * Only the two positive server outcomes that mean the caller's identity can no longer be resolved
 * trigger recovery; an unrelated infrastructure error remains visible in place.
 */
export function shouldRecoverFromWorkspaceListProblem(problem: WorkspacesProblem): boolean {
  if (problem.kind !== 'api') return false;
  if (problem.status === 401) return true;
  return problem.status === 500 && problem.code === 'authorisation_undecidable';
}

/**
 * Recover from a failed workspace request only when the response positively identifies session
 * loss. The `/workspaces` GET, create POST, shared rename/archive/restore PATCH, and the shell
 * switcher's GET all call this boundary. The native workspace-switch POST has its own server-side
 * stale-membership redirect and conceals the document before submitting.
 */
export function recoverWorkspaceSession(
  problem: WorkspacesProblem,
  actions: WorkspaceSessionRecoveryActions,
): boolean {
  if (!shouldRecoverFromWorkspaceListProblem(problem)) return false;
  actions.clearTenantState();
  actions.concealTenantDocument();
  actions.navigate(SESSION_RECOVERY_PATH);
  return true;
}
