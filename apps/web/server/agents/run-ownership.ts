/**
 * The one function `POST /api/agents/:id/runs` needs from this task: a real {@link Ownership} for
 * `decide()`'s `run` operation on `agents`, now that agents carry `created_by` and `agent_grants`
 * exists (issue #117).
 *
 * ## Why this lives here, and what calls it
 *
 * `apps/web/server/runs/api.ts` — `startRun`, the implementation behind that route — is not in
 * this task's `Owns` globs; `apps/web/server/runs/**` is W9-MODEL-129's for this wave (Wave 9's
 * plan, W9.3). Its own code carries the comment this task closes: *"Agent rows currently have no
 * creator field, so an own-only grant cannot be established here."* Before this task, that was
 * true; it no longer is, and issue #117's own acceptance criteria ("A Builder can … run resources
 * it owns", "A Viewer can run an explicitly granted agent") are unreachable without `startRun`
 * passing `decide()` something better than the `'unknown'` it hard-codes today.
 *
 * The fix that stays inside this task's globs is to keep the comparison itself here — a single,
 * narrow, exported function — and change `runs/api.ts` at the one line that calls it, declared as
 * an out-of-bounds touch on this task's PR (see `docs/adr/W9-AUTH-117-*.md`). Everything the
 * function needs is already reachable through `apps/web/server/agents/runtime.ts`'s existing,
 * already-wired registry — no new composition-root call for the "own" half, and the "permitted"
 * half degrades to "not granted" rather than a 503 when `agentGrants` is not wired (this task's
 * declared gap for that composition line, same ADR).
 */
import { ownerPrincipalIdOf } from '../rbac/owner-principal';
import type { Ownership } from '../rbac/decide';
import { currentAgentsRuntime } from './runtime';

/** The facts `runs/environment.ts`'s own `Principal` already carries that this needs. */
export interface RunOwnershipPrincipal {
  readonly workspaceId: string;
  readonly principalId: string;
  /** Who owns what this caller writes (`rbac/owner-principal.ts`, issue #509). */
  readonly ownerPrincipalId: string;
  readonly userId: string | null;
}

/**
 * `own` when `principal` created the agent, `permitted` when an `agent_grants` row names them,
 * `other` when the agent exists but neither holds, and `unknown` when the agent cannot be read at
 * all (absent, or the agents runtime is not configured) — `decide()` treats `unknown` as "deny for
 * every grant narrower than `any`", the safe direction, and `startRun`'s own subsequent
 * `env.findAgent` call still turns "does not exist" into its usual 404.
 */
export async function resolveAgentRunOwnership(
  principal: RunOwnershipPrincipal,
  agentId: string,
): Promise<Ownership> {
  const runtime = currentAgentsRuntime();
  if (runtime === null) return 'unknown';
  const agent = await runtime.agents.forWorkspace(principal.workspaceId).get(agentId);
  return ownershipOf(principal, agent, runtime.agentGrants?.forWorkspace(principal.workspaceId));
}

/**
 * The ownership rule itself, shared with the OAuth consent check (which reads the agent and the
 * grants from the database root instead of the agents runtime): one rule for who may run an agent.
 * `grants` is `undefined` when no grant store is wired, which degrades to "not granted".
 */
export async function ownershipOf(
  principal: RunOwnershipPrincipal,
  agent: { readonly id: string; readonly ownerPrincipalId: string } | null,
  grants: { hasGrant(agentId: string, userId: string): Promise<boolean> } | undefined,
): Promise<Ownership> {
  if (agent === null) return 'unknown';
  if (agent.ownerPrincipalId === ownerPrincipalIdOf(principal)) return 'own';
  if (grants === undefined || principal.userId === null) return 'other';
  return (await grants.hasGrant(agent.id, principal.userId)) ? 'permitted' : 'other';
}
