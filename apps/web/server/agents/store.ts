/**
 * The port the five agent routes talk to, and the outcomes they have to handle.
 *
 * ## Workspace scoping is structural, not a filter you remember to add
 *
 * ### What the specification actually says, and what this module adds to it
 *
 * Spec §25 "Multi-Tenant Isolation" is about the *runtime*: it requires a distinct `cwd`,
 * `CLAUDE_CONFIG_DIR`, workspace files, skills and configuration per workspace, and forbids
 * mounting a developer's `~/.claude` into a customer runtime. It says nothing about database rows,
 * and this repository should not pretend otherwise — no sentence of §25 is quoted anywhere in this
 * module, because none of them is about queries.
 *
 * Row-level workspace scoping is **this repository's extension of §25's intent** to the control
 * plane, decided here. The reasoning is that §25 treats one workspace observing another's state as
 * a correctness failure rather than a nuisance, and an agent row is workspace state in exactly the
 * sense a skill file is. Where a comment below cites §25 it is citing that reading, not a rule
 * printed in the specification. If someone amends §25 to state a database rule, this paragraph is
 * what should be deleted.
 *
 * ### How it is enforced
 *
 * A store is obtained *for a workspace* — {@link AgentStoreProvider.forWorkspace} — and the
 * resulting {@link WorkspaceAgentStore} has no method that takes a workspace id. There is
 * therefore no call site at which a workspace filter can be forgotten, because there is no
 * parameter to forget. A rule enforced by the type system does not need a reviewer to notice it.
 *
 * The obligation this shifts onto an implementation is stated once, here, so that every adapter
 * inherits it: **an implementation must bind the workspace id at `forWorkspace` time and apply it
 * to every read, every write and every uniqueness check.** `store.test.ts` states that obligation
 * as a conformance suite written against the port rather than against any implementation, and
 * there is no separate `memory-store.test.ts`: `store.test.ts` is the only suite an adapter author
 * has to satisfy.
 *
 * ## Two implementations, one suite
 *
 * `memory-store.ts` holds the whole thing in `Map`s. {@link createRepositoryAgentStoreProvider}
 * below is the PostgreSQL half — an adapter onto `packages/core/src/db/repositories/agents.ts`,
 * where the tenant is a `WorkspaceScope` the compiler will not let a caller fabricate. Both are
 * kept, because they are for different deployments and not for different stages of one:
 * `store.test.ts` runs its conformance suite — cross-workspace isolation section included —
 * against **both**, and that suite passing is the only reason to believe the two are the same
 * thing. Neither was written by reading the other (ADR-0024 §3).
 *
 * ## Why a "not found" and not a "forbidden"
 *
 * Every method here answers only about rows in its own workspace. An id that exists in another
 * workspace is reported as absent, not as forbidden — a 403 would confirm that the id exists,
 * which is an existence oracle across a tenant boundary and is the same leak in a quieter form.
 */
import {
  UnknownWorkspaceError,
  type AgentResourceAssignments,
  type AgentResourceAssignmentsInput,
  type ReplaceAgentResourcesOutcome,
  type AgentRepository as CoreAgentRepository,
  type AgentRestoreActor,
  type RestoreAgentOutcome,
  type AgentRepositoryProvider as CoreAgentRepositoryProvider,
  type AgentStoredPolicy as CoreAgentStoredPolicy,
  type WorkspaceScopeResolver as CoreWorkspaceScopeResolver,
} from '@agent-workspace/core/db';

import type { AgentPolicy, CreateAgentInput, UpdateAgentPatch } from '../../contracts/agents';
import type { AgentRecord } from './contract';

/**
 * What creating an agent can produce.
 *
 * `name-conflict` mirrors the `agents_workspace_name_key` unique index, and
 * `unknown-model-connection` mirrors the `model_connection_id` foreign key. Both are
 * *client* errors and both are named rather than collapsed into a generic failure, because the
 * two need different corrections.
 */
export type CreateAgentOutcome =
  | { readonly kind: 'created'; readonly agent: AgentRecord }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'unknown-model-connection'; readonly modelConnectionId: string }
  | { readonly kind: 'unknown-runtime-profile'; readonly runtimeProfileId: string };

export type {
  AgentResourceAssignments,
  AgentResourceAssignmentsInput,
  AgentRestoreActor,
  RestoreAgentOutcome,
};

/**
 * What creating an agent with its resource assignments can produce (W2-3): the create's refusals,
 * then the assignment's. Every refusal leaves no row — the two writes are one transaction.
 */
export type CreateAgentWithAssignmentsOutcome =
  | {
      readonly kind: 'created';
      readonly agent: AgentRecord;
      readonly assignments: AgentResourceAssignments;
    }
  | Exclude<CreateAgentOutcome, { readonly kind: 'created' }>
  | Exclude<ReplaceAgentResourcesOutcome, { readonly kind: 'updated' | 'not-found' }>;

/** What updating an agent can produce. `not-found` covers "another workspace's id", by design. */
export type UpdateAgentOutcome =
  | { readonly kind: 'updated'; readonly agent: AgentRecord }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'unknown-model-connection'; readonly modelConnectionId: string }
  | { readonly kind: 'unknown-runtime-profile'; readonly runtimeProfileId: string };

/** What deleting an agent can produce. Deletion is not idempotent here: a second call is 404. */
export type DeleteAgentOutcome = { readonly kind: 'deleted' } | { readonly kind: 'not-found' };

/** What replacing an agent's policy can produce (S-13). `not-found` covers a foreign workspace's id. */
export type ReplaceAgentPolicyOutcome =
  { readonly kind: 'updated'; readonly agent: AgentRecord } | { readonly kind: 'not-found' };

/**
 * Agent persistence for exactly one workspace.
 *
 * Every method is scoped to the workspace this instance was created for. Implementations must not
 * accept a workspace id from a caller — that is what {@link AgentStoreProvider} is for.
 */
export interface WorkspaceAgentStore {
  /** Every agent in this workspace, in a stable order the implementation documents. */
  list(): Promise<readonly AgentRecord[]>;
  /** One agent in this workspace, or `null` if this workspace has no agent with that id. */
  get(id: string): Promise<AgentRecord | null>;
  /**
   * `createdBy` is `memberships.user_id`, resolved by the route layer from the authenticated
   * principal (issue #117) — never a value the client's request body may supply.
   */
  create(
    input: CreateAgentInput,
    owner: { readonly principalId: string; readonly userId: string | null },
  ): Promise<CreateAgentOutcome>;
  /** {@link create} and an assignment replace as one write: a refused assignment leaves no row. */
  createWithAssignments(
    input: CreateAgentInput,
    owner: { readonly principalId: string; readonly userId: string | null },
    assignments: AgentResourceAssignmentsInput,
  ): Promise<CreateAgentWithAssignmentsOutcome>;
  update(id: string, patch: UpdateAgentPatch): Promise<UpdateAgentOutcome>;
  delete(id: string): Promise<DeleteAgentOutcome>;
  /** `null` writes back to "compiled" — a `PUT` may not partially replace a stored policy. */
  replacePolicy(id: string, policy: AgentPolicy | null): Promise<ReplaceAgentPolicyOutcome>;
  /** Un-archives an agent and records who did it; an agent that is not archived is left alone. */
  restore(id: string, actor: AgentRestoreActor): Promise<RestoreAgentOutcome>;
}

/** Hands out a {@link WorkspaceAgentStore} bound to one workspace. The only place an id is supplied. */
export interface AgentStoreProvider {
  forWorkspace(workspaceId: string): WorkspaceAgentStore;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The PostgreSQL implementation of the port above, as an adapter onto the repository layer.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What {@link createRepositoryAgentStoreProvider} needs, and the whole of it.
 *
 * Both are interfaces from `@agent-workspace/core/db`, imported as types. The composition root
 * constructs the implementations — it is the only module that holds a `Database` handle — and
 * hands them here.
 */
export interface RepositoryAgentStoreDependencies {
  /** Builds a repository from a scope. See `packages/core/src/db/repositories/agents.ts`. */
  readonly repositories: CoreAgentRepositoryProvider;
  /** Turns a workspace id into a scope, or answers `null`. See `.../repositories/scope.ts`. */
  readonly scopes: CoreWorkspaceScopeResolver;
}

/**
 * The core repository's stored policy, from a wire {@link AgentPolicy}. Both carry `readonly`
 * arrays and the same per-engine arms (both are built from the engine catalogue, ADR-0136), so the
 * wire value is assignable as it is; the compiler is the check that the two stay the same shape.
 */
export function toStoredPolicy(policy: AgentPolicy): CoreAgentStoredPolicy {
  return policy;
}

/**
 * The database-backed {@link AgentStoreProvider}.
 *
 * This adapter exists because the two layers name the tenant differently on purpose. The port
 * above takes a `workspaceId: string`, because that is what W1-CP-05's route handlers already
 * hold and those files are not this task's to edit. The repository takes a `WorkspaceScope`,
 * because that is what makes "every query filters on the tenant" a compile-time property rather
 * than a contract. The join between them is one lookup, here, and it is a **positive assertion**:
 * a repository is built because a `workspaces` row was found, never because the id looked
 * plausible.
 *
 * The lookup is memoised per `forWorkspace` call rather than per method call, so a request that
 * lists and then reads pays for one round trip and not two — and so that two queries in one
 * handler cannot end up scoped to two different answers.
 */
export function createRepositoryAgentStoreProvider(
  dependencies: RepositoryAgentStoreDependencies,
): AgentStoreProvider {
  return {
    forWorkspace(workspaceId: string): WorkspaceAgentStore {
      let pending: Promise<CoreAgentRepository> | null = null;
      const repository = (): Promise<CoreAgentRepository> => {
        pending ??= (async (): Promise<CoreAgentRepository> => {
          const scope = await dependencies.scopes.forWorkspaceId(workspaceId);
          // A throw and not an outcome: this is not a request the caller can correct. The workspace
          // id reaching `forWorkspace` has already been checked against a membership row by the
          // composition root, so its workspace not existing means the row was deleted underneath a
          // live session — a 500 with a name, rather than an empty list that reads as "you have no
          // agents" (ADR-0015: a check that cannot run fails; it does not fall through to the
          // answer that looks like success).
          if (scope === null) throw new UnknownWorkspaceError(workspaceId);
          return dependencies.repositories.forScope(scope);
        })();
        return pending;
      };

      return {
        async list(): Promise<readonly AgentRecord[]> {
          return (await repository()).list();
        },
        async get(id: string): Promise<AgentRecord | null> {
          return (await repository()).get(id);
        },
        async create(input, owner): Promise<CreateAgentOutcome> {
          return (await repository()).create({
            ...input,
            ownerPrincipalId: owner.principalId,
            createdBy: owner.userId,
          });
        },
        async createWithAssignments(
          input,
          owner,
          assignments,
        ): Promise<CreateAgentWithAssignmentsOutcome> {
          return (await repository()).createWithAssignments(
            { ...input, ownerPrincipalId: owner.principalId, createdBy: owner.userId },
            assignments,
          );
        },
        async update(id: string, patch: UpdateAgentPatch): Promise<UpdateAgentOutcome> {
          return (await repository()).update(id, patch);
        },
        async delete(id: string): Promise<DeleteAgentOutcome> {
          return (await repository()).delete(id);
        },
        async replacePolicy(
          id: string,
          policy: AgentPolicy | null,
        ): Promise<ReplaceAgentPolicyOutcome> {
          return (await repository()).replacePolicy(
            id,
            policy === null ? null : toStoredPolicy(policy),
          );
        },
        async restore(id: string, actor: AgentRestoreActor): Promise<RestoreAgentOutcome> {
          return (await repository()).restore(id, actor);
        },
      };
    },
  };
}
