/**
 * `agents` — the configured agent (spec §17, §18, §19.5, §27).
 *
 * The columns are §17's five-step create flow, minus the step whose table still belongs to a
 * later wave: Step 1 is `name` + `instructions`, Step 2 is `model_connection_id` + `model`,
 * Step 4 is `permissions`, and Step 5 (spec §14.9's runtime selection) is `runtime_profile_id`,
 * added by W3-CP-06 alongside the `runtime_profiles` table it references. Step 3 (files, skills,
 * connectors) needs `agent_files` / `agent_skills` / `agent_mcp_servers`, which do not exist yet,
 * so it alone is still absent here.
 *
 * **The built-in General agent is an ordinary row in this table** (§19.5 rule 3). There is no
 * `is_builtin` column, no reserved id and no branch anywhere that treats one name specially.
 * The seed inserts it exactly the way the UI would insert a user-created agent, and
 * `seed.test.ts` asserts that the row is distinguishable from a user-created agent only by its
 * name. If a later wave needs to know "is this the default agent", the answer is a workspace
 * setting pointing at an agent id — not a flag on the agent.
 */
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import {
  AGENT_PERMISSION_KEYS,
  AgentPermissionsSchema,
  AgentToolPermissionModeSchema,
} from '@indx-workspace/contracts/agents';
import {
  ENGINE_CATALOGUE,
  ENGINE_IDS,
  type EngineCatalogue,
  type EngineId,
  type ToolRulesEngineId,
  type WithholdingEngineId,
} from '@indx-workspace/contracts/engines';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { agentVersions } from './agent-versions.js';
import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { memberships } from './memberships.js';
import { modelConnections } from './model-connections.js';
import { runtimeProfiles } from './runtime-profiles.js';
import { workspaces } from './workspaces.js';
import { workspacePrincipals } from './workspace-principals.js';

/**
 * `agent_versions.(id, agent_id, workspace_id)`, explicitly typed as `AnyPgColumn`.
 *
 * `agent-versions.ts` references `agents` back (every version belongs to an agent), so this pair is
 * a schema cycle, as `workspaces` ↔ `model_connections` is: the annotation stops TypeScript from
 * inferring either table's type from the other's initializer.
 */
function materialisedVersionForeignColumns(): [AnyPgColumn, AnyPgColumn, AnyPgColumn] {
  return [agentVersions.id, agentVersions.agentId, agentVersions.workspaceId];
}

/**
 * Spec §17 Step 4, "What can this agent do?", verbatim and in the specification's order — the
 * contracts schema under the name the formal model cites.
 *
 * It is `.strict()`: an unknown key here would be a permission the compile step of §5 does
 * not know how to map onto an SDK option, and silently dropping it is exactly the failure mode
 * ADR-0015 forbids. An unknown key is a parse error.
 */
export const AgentPermissions = AgentPermissionsSchema;
export type AgentPermissions = z.infer<typeof AgentPermissions>;

/**
 * Parse an `agents.permissions` value read from the database.
 *
 * R-15 §4: `$type<T>()` is compile-time only, so a row written by an older schema, or by hand,
 * arrives typed as {@link AgentPermissions} without being one. Read through this, never
 * through the inferred type alone.
 */
export function parseAgentPermissions(value: unknown): AgentPermissions {
  return AgentPermissions.parse(value);
}

/**
 * The **engines** this schema can name — the harness that runs the agent loop (ADR-0065), never the
 * model provider (`model_connections.provider` / {@link ../model-connections.js modelProviders}).
 *
 * It lives here, next to {@link AgentStoredPolicy}, because `agents.policy` is the first column to
 * carry one; `sessions.engine` and `runs.engine` import it from this module rather than restating
 * the list. It is `@indx-workspace/contracts`' `ENGINE_IDS` itself (ADR-0136), so the CHECK
 * constraints the migrations carry are rendered from the one list, and `engine-ids.test.ts` fails
 * when a migration snapshot lags it.
 */
export const engineIds = ENGINE_IDS;
export type { EngineId };

/**
 * A replaced §17 Step 4 policy (S-13), as `agents.policy` stores it. `NULL` — not this schema at
 * all — means "compile from `permissions` and the agent's resource assignments", today's
 * behaviour for every existing row; see `apps/web/server/compose/run-request.ts`'s
 * `agentConfigFor`.
 *
 * The stored `tools` object deliberately does not re-run the R-01 §10 tool-rule grammar (only its
 * permission-mode enum is shared with `@indx-workspace/contracts/agents`), because a value only
 * reaches this column after `PUT /api/agents/:id/policy` has already validated it against
 * `@indx-workspace/contracts`' `AgentPolicySchema` (which does run that grammar), and every value
 * read back out is re-validated against the full `AgentToolPolicySchema` grammar the moment
 * `run-request.ts` composes it into a `RunRequest` and parses that. This schema's job is
 * narrower: give a row read from the database a checked shape before anything destructures it
 * (R-15 §4), not re-derive whether a tool-rule string is well-formed.
 */
const StoredSkillPolicy = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }).strict(),
  z.object({ mode: z.literal('allowlist'), names: z.array(z.string()).readonly() }).strict(),
]);

const StoredPolicyLimits = z
  .object({
    maxTurns: z.number().int().positive().nullable(),
    maxBudgetUsd: z.number().positive().finite().nullable(),
  })
  .strict();

/**
 * The arm of an engine that states narrowing in Claude's tool grammar. Every array is `readonly`, so
 * a contracts `AgentPolicy` is assignable to {@link AgentStoredPolicy} as it is (ADR-0136).
 */
function storedToolRulesArm<const E extends ToolRulesEngineId>(engine: E) {
  const settings: EngineCatalogue[E]['settings'] = ENGINE_CATALOGUE[engine].settings;
  return z
    .object({
      /** The engine discriminant (ADR-0065). Called `provider` before migration 0025 renamed it. */
      engine: z.literal(engine),
      ...settings,
      tools: z
        .object({
          base: z.union([z.literal('claude_code_preset'), z.array(z.string()).readonly()]),
          autoApprove: z.array(z.string()).readonly(),
          deny: z.array(z.string()).readonly(),
          permissionMode: AgentToolPermissionModeSchema,
          allowDangerouslySkipPermissions: z.boolean(),
        })
        .strict(),
      skills: StoredSkillPolicy,
      limits: StoredPolicyLimits,
    })
    .strict();
}

/** The arm of an engine that states narrowing as `withheldPermissions`. */
function storedWithholdingArm<const E extends WithholdingEngineId>(engine: E) {
  const settings: EngineCatalogue[E]['settings'] = ENGINE_CATALOGUE[engine].settings;
  return z
    .object({
      engine: z.literal(engine),
      ...settings,
      /** The switches the policy turns off: an engine switch's carried narrowing (ADR-0074 D12). */
      withheldPermissions: z.array(z.enum(AGENT_PERMISSION_KEYS)).readonly().optional(),
      skills: StoredSkillPolicy,
      limits: StoredPolicyLimits,
    })
    .strict();
}

/** `ENGINE_IDS` by position, so an arm names its engine without restating the id. */
const [claudeAgentSdk, openAiAgents, pi, mastra] = ENGINE_IDS;

/**
 * One arm per engine, discriminated by `engine` — the stored copy of `AgentPolicySchema`'s arms,
 * built from the same catalogue entries so the engine-native settings cannot drift from the wire
 * ones (ADR-0136).
 */
export const AgentStoredPolicy = z.discriminatedUnion('engine', [
  storedToolRulesArm(claudeAgentSdk),
  storedWithholdingArm(openAiAgents),
  storedWithholdingArm(pi),
  storedWithholdingArm(mastra),
]);

/** `true` when `A` and `B` are the same union of ids, else `never`. */
type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * Collapses to `never` unless the arms above name exactly the ids of `ENGINE_IDS`, so an engine
 * added to the list without a stored arm fails typecheck (ADR-0136).
 */
export type AgentStoredPolicy =
  SameSet<z.infer<typeof AgentStoredPolicy>['engine'], EngineId> extends never
    ? never
    : z.infer<typeof AgentStoredPolicy>;

/**
 * Parse an `agents.policy` value read from the database, or answer `null` for a NULL column.
 * Read through this, never through the inferred `$type<AgentStoredPolicy>()` alone (R-15 §4).
 */
export function parseAgentPolicy(value: unknown): AgentStoredPolicy | null {
  return value === null || value === undefined ? null : AgentStoredPolicy.parse(value);
}

export const agents = pgTable(
  'agents',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** §17 Step 1. Unique within the workspace: §19.5's agent picker labels agents by name. */
    name: text('name').notNull(),
    /** §17 Step 1. The system prompt. Empty is valid and means "no extra instructions". */
    instructions: text('instructions').notNull(),
    /**
     * §17 Step 2. NULL means "the workspace default model", which is what §19.5 rule 3 gives
     * the built-in General agent. `SET NULL` on delete rather than `CASCADE`: deleting a model
     * connection must not delete the agents that referenced it — it must make them fall back
     * to the default, which is a visible, recoverable state.
     *
     * This single-column reference carries the delete action. The tenant pairing is a *second*
     * constraint, `agents_model_connection_workspace_fk` below, because a composite
     * `ON DELETE SET NULL` would null `workspace_id` too and `workspace_id` is `NOT NULL`.
     */
    modelConnectionId: uuid('model_connection_id').references(() => modelConnections.id, {
      onDelete: 'set null',
    }),
    /** The provider-side model id at that connection, e.g. `claude-sonnet-4-5`. NULL = default. */
    model: text('model'),
    /**
     * §17 Step 5 / §14.9. NULL means "no profile chosen; the selected driver's own defaults
     * apply" — §15.1: "must never be required to create a working profile", extended here to the
     * agent that has not picked one yet. `SET NULL` on delete for the same reason
     * `model_connection_id` gives: deleting a profile must leave the agent in a visible,
     * recoverable state, not cascade into deleting the agent.
     *
     * A **reference**, never a copy. §14.9's reversibility rule is explicit: "Runtime selection
     * therefore stores a profile reference, never a copy of the profile" — switching an agent back
     * to a previously-used profile must see that profile's current settings, not a snapshot taken
     * when it was first selected.
     */
    runtimeProfileId: uuid('runtime_profile_id').references(() => runtimeProfiles.id, {
      onDelete: 'set null',
    }),
    /**
     * §17 Step 4. No database default: an agent whose permissions nobody chose is an agent
     * whose blast radius nobody chose. Every insert states all four.
     */
    permissions: jsonb('permissions').$type<AgentPermissions>().notNull(),
    /**
     * §17 Step 4's replaced policy (S-13). `NULL` — every row until a `PUT` — means "compile
     * from `permissions` and the assigned resources", so this column changes nothing for an
     * existing agent until something writes to it. See {@link AgentStoredPolicy}.
     *
     * Nullable rather than a separate one-to-one `agent_policies` table: the PR record explains
     * the trade-off (a table would add tenant-pairing and cascade machinery for no extra
     * expressiveness over a jsonb column read through {@link parseAgentPolicy}, which is this
     * table's existing house style for `permissions` above).
     */
    policy: jsonb('policy').$type<AgentStoredPolicy>(),
    /**
     * Who created this row (issue #117). Tenant-paired below as `agents_created_by_workspace_fk`,
     * against `memberships(workspace_id, user_id)` rather than against `users(id)` directly:
     * §25 forbids a workspace's ownership column from resolving to a person who was never a
     * member of it, which a bare `users.id` reference cannot express. Every existing row was
     * backfilled to its workspace's oldest Owner membership in the migration that added this
     * column — an explicit, documented owner, never NULL. See
     * `docs/adr/W9-AUTH-117-ownership-columns-and-backfill.md`.
     */
    createdBy: uuid('created_by'),
    ownerPrincipalId: uuid('owner_principal_id').notNull(),
    /**
     * When first-run setup last configured and tested this agent, or `NULL` for an agent setup never
     * touched (issue #393, PR #403 review). The composer selects the workspace's most recently
     * configured one before the user chooses an agent. Recorded on the agent rather than as an id
     * on `workspaces`, so it needs no reference back into this table (no schema cycle) and a deleted
     * agent simply takes its mark with it.
     */
    setupConfiguredAt: timestamp('setup_configured_at', { withTimezone: true, mode: 'date' }),
    /**
     * The version this row was last written from (issue #613), or `NULL` once a write outside the
     * version pipeline (`PATCH`, `PUT /policy`, `PUT /resources`) has edited it. "Edited since the
     * pointer moved" is `materialised_version_id IS DISTINCT FROM pointer.version_id`; it replaces
     * the old `updated_at <= pointer.updated_at` proxy. Agent-paired below as
     * `agents_materialised_version_fk`.
     */
    materialisedVersionId: uuid('materialised_version_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('agents_workspace_name_key').on(table.workspaceId, table.name),
    // The target a tenant-paired reference to an agent needs. `id` is already the primary key,
    // so this adds no new restriction on the data; it exists because PostgreSQL will only
    // accept `REFERENCES agents (id, workspace_id)` when (id, workspace_id) is unique.
    // Declared as a table CONSTRAINT rather than a unique INDEX on purpose. drizzle-kit
    // emits every `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` before it emits any
    // `CREATE UNIQUE INDEX`, so a composite foreign key pointing at a unique *index*
    // fails the migration with "there is no unique constraint matching the given keys".
    // A constraint is emitted inside CREATE TABLE, which is early enough.
    unique('agents_id_workspace_key').on(table.id, table.workspaceId),
    index('agents_model_connection_idx').on(table.modelConnectionId),
    index('agents_runtime_profile_idx').on(table.runtimeProfileId),
    index('agents_owner_principal_idx').on(table.ownerPrincipalId),
    // §25: an agent must not be able to spend another workspace's provider credential. The
    // single-column reference above says the connection exists; this one says it belongs to
    // *this* workspace. `MATCH SIMPLE` (PostgreSQL's default) does not enforce a composite
    // foreign key when any of its columns is NULL, which is exactly the behaviour wanted here:
    // an agent with no connection (`model_connection_id IS NULL`) is unconstrained, and that is
    // also the state the `SET NULL` action above leaves behind when a connection is deleted.
    foreignKey({
      columns: [table.modelConnectionId, table.workspaceId],
      foreignColumns: [modelConnections.id, modelConnections.workspaceId],
      name: 'agents_model_connection_workspace_fk',
    }),
    // §25, same shape: an agent must not be able to select another workspace's runtime profile.
    foreignKey({
      columns: [table.runtimeProfileId, table.workspaceId],
      foreignColumns: [runtimeProfiles.id, runtimeProfiles.workspaceId],
      name: 'agents_runtime_profile_workspace_fk',
    }),
    // §25/§21: the creator recorded on a row must hold a membership in the same workspace. See
    // `created_by`'s own comment above for why this points at `memberships`, not at `users`.
    foreignKey({
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [memberships.workspaceId, memberships.userId],
      name: 'agents_created_by_workspace_fk',
    }),
    foreignKey({
      columns: [table.workspaceId, table.ownerPrincipalId],
      foreignColumns: [workspacePrincipals.workspaceId, workspacePrincipals.id],
      name: 'agents_owner_principal_workspace_fk',
    }),
    // Refuses another agent's or another workspace's version, the same shape as
    // `agent_version_pointers_version_fk`. NO ACTION on delete: a version is only ever deleted by
    // its agent's cascade, which removes this row in the same statement. MATCH SIMPLE leaves NULL
    // unchecked.
    foreignKey({
      columns: [table.materialisedVersionId, table.id, table.workspaceId],
      foreignColumns: materialisedVersionForeignColumns(),
      name: 'agents_materialised_version_fk',
    }),
    check('agents_name_not_blank', sql`length(btrim(${table.name})) > 0`),
  ],
);

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
