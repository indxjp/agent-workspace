/**
 * The archived-workspace refusal issue #119 asks for: "Archived workspaces … are excluded from new
 * run/session creation." One owned, unit-testable module, composed from
 * `apps/web/server/composition/register.ts` at every seam that creates a NEW run or session —
 * never a new file per call site, and never left as inline logic with no test but the predicate's
 * own.
 *
 * ## Why this module exists (verification round 1, finding 2)
 *
 * Before this file, `register.ts` inlined `isWorkspaceUsableForRuns(workspace)` at its two call
 * sites (`findAgent`, `openSession`) and exported only the predicate for
 * `register-archived-guard.test.ts` to unit-test. That proved the three-line function correct but
 * proved nothing about the two `if (!isWorkspaceUsableForRuns(workspace)) return null;` lines
 * themselves — deleting *those* left every PR test green, because nothing called `findAgent` or
 * `openSession` at all. `run-gate-integration.test.ts` beside this file drives the installed
 * closures (`getRunApi()!.findAgent`/`.openSession`) end to end against a real database, which is
 * only possible because the check they perform is now one line delegating to {@link RunGate},
 * not a private local variable read.
 *
 * ## Why `createRunGate` takes the repository, not a workspace record
 *
 * `register.ts`'s `findAgent`/`openSession` each already have `principal.workspaceId` and nothing
 * else at the point they need an answer — reading the workspace row is this module's job, not
 * theirs, so a call site is exactly one line: `if (!(await runGate.isUsable(principal.workspaceId)))
 * return null;`. `createRunGate` is tested directly with a fake `{ get }` in
 * `run-gate.test.ts`, and driven through the real thing in `run-gate-integration.test.ts`.
 */
import type {
  EnsureSessionInput,
  EnsureSessionOutcome,
  SessionRepository,
} from '@agent-workspace/core/db';

import type { WorkspaceRepositoryPort } from './runtime';

/**
 * `null` (the workspace row is gone) is treated the same as archived: a request naming a
 * nonexistent workspace has nothing usable to run in either. Kept as its own export — not folded
 * into {@link RunGate} — because `register-archived-guard.test.ts` already unit-tests this exact
 * pure predicate by name and nothing is gained by breaking that link.
 */
export function isWorkspaceUsableForRuns(
  workspace: { readonly archivedAt: Date | null } | null,
): boolean {
  return workspace !== null && workspace.archivedAt === null;
}

/** A gate closed over one workspace repository, so a call site needs only the workspace id. */
export interface RunGate {
  /** `false` when `workspaceId` names an archived or missing workspace. */
  isUsable(workspaceId: string): Promise<boolean>;
}

/** Build a {@link RunGate} over the same `WorkspaceRepository` `/api/workspaces` reads. */
export function createRunGate(repository: Pick<WorkspaceRepositoryPort, 'get'>): RunGate {
  return {
    async isUsable(workspaceId: string): Promise<boolean> {
      return isWorkspaceUsableForRuns(await repository.get(workspaceId));
    },
  };
}

/**
 * Wrap a `SessionRepository` so its one row-creating method, `ensure`, refuses once `gate` says
 * `workspaceId` is not usable; every other method (`get`, `list`, `update`, `archive`, `restore`)
 * passes through unchanged — issue #119 excludes an archived workspace from *new* run/session
 * creation, never from reading or archiving a session that already exists.
 *
 * Verification round 1, finding 3: `apps/web/server/composition/register.ts` hands
 * the projects runtime (issue #125, `apps/web/server/projects/**`, outside this task's
 * `Owns`) a bare `SessionRepository` with no archived check at all, so
 * `POST /api/projects/:id/sessions` created a session in an archived workspace. That route, and
 * `SessionRepository`/`EnsureSessionOutcome` themselves (`packages/core/src/db/repositories/runs.ts`),
 * are both outside this task's `Owns`, so the fix is this wrapper, applied at the one seam inside
 * `register.ts` that *is* owned: the provider `wireProjects` returns.
 *
 * `EnsureSessionOutcome` is a closed union with no "workspace archived" member and this task
 * cannot add one, so the refusal is reported as `{ kind: 'unknown-principal' }`. This keeps the
 * refusal keyed to the exact caller even for API-key principals without a human user id, and every
 * caller already treats it as a real, non-`created`/`existing` result.
 */
export function guardSessionCreation(
  sessions: SessionRepository,
  workspaceId: string,
  gate: RunGate,
): SessionRepository {
  return {
    ...sessions,
    async ensure(input: EnsureSessionInput): Promise<EnsureSessionOutcome> {
      if (!(await gate.isUsable(workspaceId))) {
        return { kind: 'unknown-principal', principalId: input.ownerPrincipalId };
      }
      return sessions.ensure(input);
    },
  };
}
