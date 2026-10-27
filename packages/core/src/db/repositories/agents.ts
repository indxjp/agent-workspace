/**
 * The agent repository — the first instance of the shape every Wave 2 resource copies.
 *
 * Read `./scope.ts` first: the one property that matters here is that {@link AgentRepository} is
 * obtained *for a {@link WorkspaceScope}* and that no method on it takes a workspace id. Every
 * `where` clause below opens with `eq(agents.workspaceId, scope.workspaceId)` and is built inside
 * this file, so a caller has no way to write a query that forgets the tenant.
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
 * Anything else is re-thrown. {@link classifyWriteFailure} decides on a positive assertion — a
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
import { and, asc, eq, type SQL } from 'drizzle-orm';

import type { AgentCreatedByAgent, BuiltinAgentKey } from '@indx-workspace/contracts/agents';

import {
  createDatabaseAgentResourceRepositoryProvider,
  type AgentResourceAssignments,
  type AgentResourceAssignmentsInput,
  type ReplaceAgentResourcesOutcome,
} from './agent-resources.js';
import type { Executor } from './agent-versions-shared.js';
import {
  agents,
  parseAgentPermissions,
  parseAgentPolicy,
  parseBuiltinKey,
  type AgentPermissions as StoredAgentPermissions,
  type AgentStoredPolicy as StoredAgentPolicy,
} from '../schema/agents.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';
import { postgresViolations } from './violations.js';

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

/** What deleting an agent can produce. Deletion is not idempotent: a second call is `not-found`. */
export type DeleteAgentOutcome = { readonly kind: 'deleted' } | { readonly kind: 'not-found' };

/** What replacing an agent's policy can produce. `not-found` covers "another workspace's id". */
export type ReplaceAgentPolicyOutcome =
  { readonly kind: 'updated'; readonly agent: AgentRecord } | { readonly kind: 'not-found' };

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
 * The constraint names this module knows how to turn into an outcome.
 *
 * Transcribed from `migrations/0000_init.sql`, which is the artefact PostgreSQL actually reports.
 * `agents_workspace_name_key` is a unique *index*; PostgreSQL still reports its name in the
 * error's `constraint` field, which is why it can be matched the same way as the two foreign keys.
 */
const NAME_CONFLICT_CONSTRAINTS: ReadonlySet<string> = new Set(['agents_workspace_name_key']);
const MODEL_CONNECTION_CONSTRAINTS: ReadonlySet<string> = new Set([
  'agents_model_connection_id_model_connections_id_fk',
  'agents_model_connection_workspace_fk',
]);
const RUNTIME_PROFILE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'agents_runtime_profile_id_runtime_profiles_id_fk',
  'agents_runtime_profile_workspace_fk',
]);

/** PostgreSQL SQLSTATE classes this module classifies. Anything else is somebody else's problem. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Classify a write failure, or answer `null`.
 *
 * Positive assertion, twice over: a failure is a name conflict because its SQLSTATE was
 * `23505` **and** its constraint was one of the names above. A `null` return means "this module
 * does not know what this is", and every caller re-throws on it rather than reporting a plausible
 * client error for a failure that might be a dropped connection (ADR-0015).
 */
function classifyWriteFailure(
  error: unknown,
): 'name-conflict' | 'unknown-model-connection' | 'unknown-runtime-profile' | null {
  for (const failure of postgresViolations(error)) {
    if (failure.code === UNIQUE_VIOLATION && NAME_CONFLICT_CONSTRAINTS.has(failure.constraint)) {
      return 'name-conflict';
    }
    if (
      failure.code === FOREIGN_KEY_VIOLATION &&
      MODEL_CONNECTION_CONSTRAINTS.has(failure.constraint)
    ) {
      return 'unknown-model-connection';
    }
    if (
      failure.code === FOREIGN_KEY_VIOLATION &&
      RUNTIME_PROFILE_CONSTRAINTS.has(failure.constraint)
    ) {
      return 'unknown-runtime-profile';
    }
  }
  return null;
}

/** The columns a read selects. Written out so a schema change that drops one is a compile error. */
const AGENT_COLUMNS = {
  id: agents.id,
  workspaceId: agents.workspaceId,
  name: agents.name,
  instructions: agents.instructions,
  modelConnectionId: agents.modelConnectionId,
  model: agents.model,
  runtimeProfileId: agents.runtimeProfileId,
  permissions: agents.permissions,
  policy: agents.policy,
  createdBy: agents.createdBy,
  ownerPrincipalId: agents.ownerPrincipalId,
  builtinKey: agents.builtinKey,
  createdByAgentId: agents.createdByAgentId,
  createdByAgentVersion: agents.createdByAgentVersion,
  createdByRunId: agents.createdByRunId,
  archivedAt: agents.archivedAt,
  createdAt: agents.createdAt,
  updatedAt: agents.updatedAt,
} as const;

/** One selected row into an {@link AgentRecord}, parsing `permissions` rather than trusting it. */
function toRecord(row: {
  id: string;
  workspaceId: string;
  name: string;
  instructions: string;
  modelConnectionId: string | null;
  model: string | null;
  runtimeProfileId: string | null;
  permissions: unknown;
  policy: unknown;
  createdBy: string | null;
  ownerPrincipalId: string;
  builtinKey: string | null;
  createdByAgentId: string | null;
  createdByAgentVersion: number | null;
  createdByRunId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): AgentRecord {
  const builtin = parseBuiltinKey(row.builtinKey);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    instructions: row.instructions,
    modelConnectionId: row.modelConnectionId,
    model: row.model,
    runtimeProfileId: row.runtimeProfileId,
    permissions: parseAgentPermissions(row.permissions),
    policy: parseAgentPolicy(row.policy),
    createdBy: row.createdBy,
    ownerPrincipalId: row.ownerPrincipalId,
    ...(builtin === undefined ? {} : { builtin }),
    // The lineage CHECK makes the version and the run both present or both absent.
    ...(row.createdByAgentVersion === null || row.createdByRunId === null
      ? {}
      : {
          createdByAgent: {
            agentId: row.createdByAgentId,
            version: row.createdByAgentVersion,
            runId: row.createdByRunId,
          },
        }),
    ...(row.archivedAt === null ? {} : { archivedAt: row.archivedAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Private: thrown inside a transaction to roll it back, and caught by the method that threw it. */
class Rollback extends Error {
  constructor(readonly outcome: Exclude<CreateAgentWithAssignmentsOutcome, { kind: 'created' }>) {
    super(`agent create rolled back: ${outcome.kind}`);
  }
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

      return {
        async list(): Promise<readonly AgentRecord[]> {
          const rows = await db
            .select(AGENT_COLUMNS)
            .from(agents)
            .where(tenant)
            // Total and stable, and identical to the in-memory store's documented order: oldest
            // first, ties broken by id. Without the second key two rows sharing a `created_at`
            // could come back in either order and a list test would be flaky rather than wrong.
            .orderBy(asc(agents.createdAt), asc(agents.id));
          return rows.map(toRecord);
        },

        async get(id: string): Promise<AgentRecord | null> {
          const rows = await db
            .select(AGENT_COLUMNS)
            .from(agents)
            .where(within(eq(agents.id, id)))
            .limit(1);
          const row = rows[0];
          return row === undefined ? null : toRecord(row);
        },

        async create(input: CreateAgentInput): Promise<CreateAgentOutcome> {
          try {
            const rows = await db
              .insert(agents)
              .values({
                // Not from the caller. An insert cannot name a workspace; it inherits the scope's.
                workspaceId: checked.workspaceId,
                name: input.name,
                instructions: input.instructions,
                modelConnectionId: input.modelConnectionId,
                model: input.model,
                runtimeProfileId: input.runtimeProfileId ?? null,
                permissions: { ...input.permissions },
                ownerPrincipalId: input.ownerPrincipalId,
                createdBy: input.createdBy ?? null,
                createdByAgentId: input.createdByAgent?.agentId ?? null,
                createdByAgentVersion: input.createdByAgent?.version ?? null,
                createdByRunId: input.createdByAgent?.runId ?? null,
              })
              .returning(AGENT_COLUMNS);
            const row = rows[0];
            if (row === undefined) {
              throw new Error('the insert returned no row');
            }
            return { kind: 'created', agent: toRecord(row) };
          } catch (error) {
            const classified = classifyWriteFailure(error);
            if (classified === 'name-conflict') return { kind: 'name-conflict', name: input.name };
            if (classified === 'unknown-model-connection') {
              return {
                kind: 'unknown-model-connection',
                modelConnectionId: input.modelConnectionId ?? '',
              };
            }
            if (classified === 'unknown-runtime-profile') {
              return {
                kind: 'unknown-runtime-profile',
                runtimeProfileId: input.runtimeProfileId ?? '',
              };
            }
            throw error;
          }
        },

        async createWithAssignments(input, assignments) {
          try {
            return await db.transaction(async (tx) => {
              // The same create and replace as the single writes, over the transaction, so the
              // rules (constraint mapping, the #133 file ceiling) are stated once.
              const created = await createDatabaseAgentRepositoryProvider(tx)
                .forScope(scope)
                .create(input);
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
        },

        async update(id: string, patch: UpdateAgentPatch): Promise<UpdateAgentOutcome> {
          // Only the keys the patch actually carries. `exactOptionalPropertyTypes` makes
          // `patch.name !== undefined` mean "the key was supplied", so a nullable column can be
          // set back to null without an absent key being read as one.
          const changes: {
            name?: string;
            instructions?: string;
            modelConnectionId?: string | null;
            model?: string | null;
            runtimeProfileId?: string | null;
            permissions?: AgentPermissions;
          } = {};
          if (patch.name !== undefined) changes.name = patch.name;
          if (patch.instructions !== undefined) changes.instructions = patch.instructions;
          if (patch.modelConnectionId !== undefined) {
            changes.modelConnectionId = patch.modelConnectionId;
          }
          if (patch.model !== undefined) changes.model = patch.model;
          if (patch.runtimeProfileId !== undefined)
            changes.runtimeProfileId = patch.runtimeProfileId;
          if (patch.permissions !== undefined) changes.permissions = { ...patch.permissions };

          if (Object.keys(changes).length === 0) {
            // An empty patch must still answer not-found for an id this workspace does not have,
            // so it is a read rather than a no-op that reports success.
            const rows = await db
              .select(AGENT_COLUMNS)
              .from(agents)
              .where(within(eq(agents.id, id)))
              .limit(1);
            const row = rows[0];
            return row === undefined
              ? { kind: 'not-found' }
              : { kind: 'updated', agent: toRecord(row) };
          }

          try {
            // An edit outside the version pipeline: the row no longer equals a version.
            const rows = await db
              .update(agents)
              .set({ ...changes, materialisedVersionId: null })
              .where(within(eq(agents.id, id)))
              .returning(AGENT_COLUMNS);
            const row = rows[0];
            // No row matched: either no such id, or the id belongs to another workspace. The two
            // are the same answer on purpose — see the file header.
            if (row === undefined) return { kind: 'not-found' };
            return { kind: 'updated', agent: toRecord(row) };
          } catch (error) {
            const classified = classifyWriteFailure(error);
            if (classified === 'name-conflict') {
              return { kind: 'name-conflict', name: patch.name ?? '' };
            }
            if (classified === 'unknown-model-connection') {
              return {
                kind: 'unknown-model-connection',
                modelConnectionId: patch.modelConnectionId ?? '',
              };
            }
            if (classified === 'unknown-runtime-profile') {
              return {
                kind: 'unknown-runtime-profile',
                runtimeProfileId: patch.runtimeProfileId ?? '',
              };
            }
            throw error;
          }
        },

        async delete(id: string): Promise<DeleteAgentOutcome> {
          const rows = await db
            .delete(agents)
            .where(within(eq(agents.id, id)))
            .returning({ id: agents.id });
          return rows.length > 0 ? { kind: 'deleted' } : { kind: 'not-found' };
        },

        async replacePolicy(
          id: string,
          policy: AgentStoredPolicy | null,
        ): Promise<ReplaceAgentPolicyOutcome> {
          const rows = await db
            .update(agents)
            .set({ policy, materialisedVersionId: null })
            .where(within(eq(agents.id, id)))
            .returning(AGENT_COLUMNS);
          const row = rows[0];
          return row === undefined
            ? { kind: 'not-found' }
            : { kind: 'updated', agent: toRecord(row) };
        },
      };
    },
  };
}
