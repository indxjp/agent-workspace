/**
 * The agent repository — the first instance of the shape every Wave 2 resource copies.
 *
 * Read `./scope.ts` first: the one property that matters here is that {@link AgentRepository} is
 * obtained *for a {@link WorkspaceScope}* and that no method on it takes a workspace id. Every
 * `where` clause below opens with `eq(agents.workspaceId, scope.workspaceId)` and is built inside
 * this file or `./agents/`, so a caller has no way to write a query that forgets the tenant.
 *
 * ## What the outcomes are, and why they are not exceptions
 *
 * Three things can go wrong on a write and each needs a different correction by the person who
 * made the request, so each is a named member of a discriminated union rather than a thrown error
 * a caller has to pattern-match on a message:
 *
 *   * `name-conflict` — `agents_workspace_name_key`, unique on `(workspace_id, name)`.
 *   * `unknown-model-connection` — `agents_model_connection_id_model_connections_id_fk` (the id
 *     names nothing) or `agents_model_connection_workspace_fk` (it names another workspace's
 *     connection, spec §25). Both are the same correction — choose a connection this workspace
 *     has — so both map here.
 *   * `not-found` — including "that id belongs to another workspace". Reported as absent rather
 *     than as forbidden, because a 403 would confirm the id exists, which is an existence oracle
 *     across a tenant boundary.
 *
 * Anything else is re-thrown. `classifyWriteFailure` (`./agents/rows.ts`) decides on a positive assertion — a
 * violation is classified because its SQLSTATE and its constraint name were both recognised, never
 * because nothing else matched — and its final arm returns `null`, which the callers turn back
 * into a throw (ADR-0015).
 *
 * ## Reading `permissions`
 *
 * `jsonb().$type<AgentPermissions>()` is a compile-time assertion and nothing more: R-15 §4 records
 * that a row written by an older schema, or by hand, arrives typed as `AgentPermissions` without
 * being one. Every read below goes through `parseAgentPermissions`, so a malformed row is a loud
 * parse failure at the boundary rather than a permission silently reading as `undefined` — which
 * is falsy, and therefore a permission that would be *granted* by any check written the obvious
 * way round.
 */
import { and, eq, type SQL } from 'drizzle-orm';

import type { AgentCreatedByAgent, BuiltinAgentKey } from '@indx-workspace/contracts/agents';

import {
  createDatabaseAgentResourceRepositoryProvider,
  type AgentResourceAssignments,
  type AgentResourceAssignmentsInput,
  type ReplaceAgentResourcesOutcome,
} from './agent-resources.js';
import type { Executor } from './agent-versions-shared.js';
import { createAgentArchive } from './agents/archive.js';
import { Rollback } from './agents/rows.js';
import { createAgentWrites } from './agents/writes.js';
import {
  agents,
  type AgentPermissions as StoredAgentPermissions,
  type AgentStoredPolicy as StoredAgentPolicy,
} from '../schema/agents.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

/** Spec §17 Step 4's four booleans, as the `agents.permissions` column stores them. */
export type AgentPermissions = StoredAgentPermissions;

/** S-13's replaced policy, as the `agents.policy` column stores it. `null` means "compiled". */
export type AgentStoredPolicy = StoredAgentPolicy;

/** One agent row, with `timestamptz` columns as `Date`. */
export interface AgentRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly instructions: string;
  readonly modelConnectionId: string | null;
  readonly model: string | null;
  readonly runtimeProfileId: string | null;
  readonly permissions: AgentPermissions;
  /** `null` means "compile from `permissions` and the assigned resources" (today's behaviour). */
  readonly policy: AgentStoredPolicy | null;
  /** Compatibility attribution for a human writer; never used for principal ownership. */
  readonly createdBy: string | null;
  /** Exact human or API-key owner. */
  readonly ownerPrincipalId: string;
  /** Which built-in agent this is; absent on every ordinary agent. */
  readonly builtin?: BuiltinAgentKey;
  /** Lineage of an agent made by an agent; absent on a person-made agent (issue #1851). */
  readonly createdByAgent?: AgentCreatedByAgent;
  /** When the agent was archived; absent while active, as `projects.archived_at` (issue #1851). */
  readonly archivedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Everything an insert supplies. The workspace is not among them — it comes from the scope.
 *
 * `ownerPrincipalId` is resolved from the authenticated actor and never trusted from a request
 * body. `createdBy` is compatibility attribution for membership principals; machine principals
 * leave it null rather than inventing a human identity.
 */
export interface CreateAgentInput {
  readonly name: string;
  readonly instructions: string;
  readonly modelConnectionId: string | null;
  readonly model: string | null;
  readonly runtimeProfileId?: string | null;
  readonly permissions: AgentPermissions;
  readonly ownerPrincipalId: string;
  readonly createdBy?: string | null;
  /** Lineage of an agent made by an agent; omitted for a person-made agent (issue #1851). */
  readonly createdByAgent?: AgentCreatedByAgent & { readonly agentId: string };
}

/** Everything an update may change. An absent key is "leave it alone". */
export interface UpdateAgentPatch {
  readonly name?: string;
  readonly instructions?: string;
  readonly modelConnectionId?: string | null;
  readonly model?: string | null;
  readonly runtimeProfileId?: string | null;
  readonly permissions?: AgentPermissions;
}

/** What creating an agent can produce. */
export type CreateAgentOutcome =
  | { readonly kind: 'created'; readonly agent: AgentRecord }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'unknown-model-connection'; readonly modelConnectionId: string }
  | { readonly kind: 'unknown-runtime-profile'; readonly runtimeProfileId: string };

/**
 * What creating an agent together with its resource assignments can produce (W2-3): the create's
 * refusals, then the assignment's. Any refusal rolls the whole write back, so it leaves no row.
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

/** What restoring an agent can produce. `not-archived` is the no-op: the agent is active already. */
export type RestoreAgentOutcome =
  | { readonly kind: 'restored'; readonly agent: AgentRecord }
  | { readonly kind: 'not-archived'; readonly agent: AgentRecord }
  | { readonly kind: 'not-found' };

/** Who restores an agent, as the `agent-changed` audit row names them. */
export interface AgentRestoreActor {
  readonly principalId: string;
  readonly userId: string | null;
  readonly label: string;
}

/** What deleting an agent can produce. Deletion is not idempotent: a second call is `not-found`. */
export type DeleteAgentOutcome = { readonly kind: 'deleted' } | { readonly kind: 'not-found' };

/** What replacing an agent's policy can produce. `not-found` covers "another workspace's id". */
export type ReplaceAgentPolicyOutcome =
  { readonly kind: 'updated'; readonly agent: AgentRecord } | { readonly kind: 'not-found' };

/** An agent the auto-archive sweep may archive, with what its rule reads (issue #1851). */
interface AgentArchiveCandidate {
  readonly id: string;
  readonly createdAt: Date;
  /** The newest run of any session of the agent, or `null` when it never ran. */
  readonly lastRunAt: Date | null;
  /** The lineage; present on every candidate, because only an agent-made agent is a candidate. */
  readonly createdByAgent: AgentCreatedByAgent;
}

/** Narrowing for {@link AgentRepository.listArchiveCandidates}; the caller's rule decides. */
interface AgentArchiveCandidateQuery {
  /** Only agents created before this instant. */
  readonly createdBefore: Date;
  /** Never an agent restored at or after this instant: a restore gives it a fresh window. */
  readonly notRestoredSince: Date;
  /** Keyset: only ids after this one, in id order. */
  readonly afterId: string | null;
  readonly limit: number;
}

/**
 * Agent persistence for exactly one workspace.
 *
 * No method takes a workspace id. That is the whole design: there is no parameter at which the
 * tenant filter can be forgotten, so "every query filters on the scope" is a property of the
 * signatures rather than a rule in a comment.
 */
export interface AgentRepository {
  /** Every agent in this workspace, oldest first, ties broken by id — a total, stable order. */
  list(): Promise<readonly AgentRecord[]>;
  /** One agent in this workspace, or `null` if this workspace has no agent with that id. */
  get(id: string): Promise<AgentRecord | null>;
  create(input: CreateAgentInput): Promise<CreateAgentOutcome>;
  /** The row and its assignments in one transaction: a refused assignment leaves no row. */
  createWithAssignments(
    input: CreateAgentInput,
    assignments: AgentResourceAssignmentsInput,
  ): Promise<CreateAgentWithAssignmentsOutcome>;
  update(id: string, patch: UpdateAgentPatch): Promise<UpdateAgentOutcome>;
  delete(id: string): Promise<DeleteAgentOutcome>;
  /** `null` writes back to "compiled" — a `PUT` may not partially replace a stored policy. */
  replacePolicy(id: string, policy: AgentStoredPolicy | null): Promise<ReplaceAgentPolicyOutcome>;
  /**
   * Not-yet-archived, agent-made agents created before `createdBefore`, by id after `afterId`. A
   * prefilter only: the sweep's rule (the last run included) is applied by the caller.
   */
  listArchiveCandidates(
    query: AgentArchiveCandidateQuery,
  ): Promise<readonly AgentArchiveCandidate[]>;
  /**
   * Archives these agents at `at`, one `agent-changed` audit row each, in one transaction, and
   * returns the ids it archived. An id already archived, or not in this workspace, is skipped, so a
   * repeat or a concurrent sweep archives nothing twice and writes no second audit row.
   */
  archive(ids: readonly string[], at: Date): Promise<readonly string[]>;
  /**
   * Clears `archived_at` and writes one `agent-changed` audit row `{ archived: false }` in one
   * transaction. An agent that is not archived is left as it is with no audit row, so a repeat or a
   * concurrent restore writes nothing twice.
   */
  restore(id: string, actor: AgentRestoreActor): Promise<RestoreAgentOutcome>;
}

/**
 * Hands out an {@link AgentRepository} bound to one workspace.
 *
 * `forScope` takes a {@link WorkspaceScope} and nothing else. Passing a workspace id string is a
 * compile error, and `scope-forgery.test.ts` proves it by running `tsc` over that exact line.
 */
export interface AgentRepositoryProvider {
  forScope(scope: WorkspaceScope): AgentRepository;
}

/**
 * The PostgreSQL {@link AgentRepositoryProvider}.
 *
 * One `db` handle, one provider, any number of scopes. The handle is a pool, so the repositories
 * this hands out are cheap: `forScope` allocates a closure and issues no query.
 */
export function createDatabaseAgentRepositoryProvider(db: Executor): AgentRepositoryProvider {
  return {
    forScope(scope: WorkspaceScope): AgentRepository {
      // The run-time half of the scope gate, before any predicate is built. The compiler admits
      // an `as WorkspaceScope` cast and `Object.create(WorkspaceScope.prototype)`; this refuses
      // both by name. Until verification round 1 the predicate it calls had no call site outside
      // its own unit test, and both forgeries read another workspace's rows.
      const checked = requireWorkspaceScope(scope, 'AgentRepositoryProvider');
      // The tenant is captured here, once, from the scope. Nothing below reads a workspace id
      // from anywhere else, and every predicate is built by `within`.
      const tenant = eq(agents.workspaceId, checked.workspaceId);
      const within = (rest: SQL): SQL => {
        const combined = and(tenant, rest);
        // `and()` is typed as possibly-undefined because it accepts an empty argument list. It is
        // called here with two defined predicates, so this arm is unreachable — and it throws
        // rather than degrading to `rest` alone, because degrading would drop the tenant filter,
        // which is the one failure this module exists to make impossible.
        if (combined === undefined) throw new Error('the workspace predicate could not be built');
        return combined;
      };

      const context = { db, checked, tenant, within };
      return {
        ...createAgentWrites(context),
        createWithAssignments: (input, assignments) =>
          createWithAssignments(db, scope, input, assignments),
        ...createAgentArchive(context),
      };
    },
  };
}

/** {@link AgentRepository.createWithAssignments}: the single writes again, over one transaction. */
async function createWithAssignments(
  db: Executor,
  scope: WorkspaceScope,
  input: CreateAgentInput,
  assignments: AgentResourceAssignmentsInput,
): Promise<CreateAgentWithAssignmentsOutcome> {
  try {
    return await db.transaction(async (tx) => {
      // The same create and replace as the single writes, over the transaction, so the
      // rules (constraint mapping, the #133 file ceiling) are stated once.
      const created = await createDatabaseAgentRepositoryProvider(tx).forScope(scope).create(input);
      if (created.kind !== 'created') throw new Rollback(created);
      const assigned = await createDatabaseAgentResourceRepositoryProvider(tx)
        .forScope(scope)
        .replace(created.agent.id, assignments);
      if (assigned.kind === 'not-found') {
        throw new Error(`agent ${created.agent.id} vanished inside its own create`);
      }
      if (assigned.kind !== 'updated') throw new Rollback(assigned);
      // `updated_at` is `now()`, the transaction's start, so the created row is still current.
      return {
        kind: 'created' as const,
        agent: created.agent,
        assignments: assigned.assignments,
      };
    });
  } catch (error) {
    if (error instanceof Rollback) return error.outcome;
    throw error;
  }
}
