/**
 * The run-ownership port: who may run an agent, as `decide()`'s `run` operation needs it.
 *
 * The rule lives with the agents (`agents/run-ownership.ts`), which load the agent and its grants.
 * Integrations — the A2A endpoint, endpoint clients, triggers and the tool endpoint — are upstream
 * of agents, so they ask through this port instead of importing that module, and the composition
 * root hands them the agents implementation (refactoring plan part 08, step 3).
 */
import type { Ownership } from './decide';
import type { Caller } from './principal';

/**
 * The fields of the one {@link Caller} type the rule needs (part 06 step 9); `runs/environment.ts`'s
 * `RunPrincipal` carries them all. `ownerPrincipalId` is who owns what this caller writes
 * (`rbac/core/owner-principal.ts`, issue #509).
 */
export type RunOwnershipPrincipal = Pick<
  Caller,
  'workspaceId' | 'principalId' | 'ownerPrincipalId' | 'userId'
>;

/** `own`, `permitted`, `other`, or `unknown` when the agent cannot be read at all. */
export type ResolveRunOwnership = (
  principal: RunOwnershipPrincipal,
  agentId: string,
) => Promise<Ownership>;
