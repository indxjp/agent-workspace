/**
 * `runtime_profiles` — spec §15.1's `RuntimeProfile`, stored (spec §27, §34, W3-CP-06's 3a-2 cell).
 *
 * §27 lists this table and no earlier wave claims it — `index.ts`'s header used to say so in as
 * many words ("`runtime_profiles` is Wave 3's"). This file is that table.
 *
 * ## Column set
 *
 * Every field of §15.1's `RuntimeProfile` interface, one column each, plus the tenant column
 * every table in this schema carries. `driverConfig` is stored as untyped `jsonb`: §15.1 calls it
 * "the escape hatch... validated per driver with Zod, hidden under 'Advanced'", and no driver's
 * `driverConfig` shape exists in this wave to validate against — the drivers land at 3b and 3c.
 * That per-driver validation is therefore a declared gap on this task's PR, not something this
 * column pretends to do.
 *
 * `runtimeConnectionId` references `secrets.id`, not a `runtime_connections` table — see
 * `docs/adr/W3-CP-06-runtime-connections-are-secrets.md`. Spec §14.9 states a runtime connection's
 * whole contract in one line: *"A runtime connection exists — endpoint + credentials, stored as a
 * secret."* This task's `Owns` cell does not grant a new table for it, and it does not need one:
 * the `secrets` table (§23) already stores an encrypted blob under a workspace-scoped id, which is
 * exactly what an "endpoint + credentials" pair is.
 *
 * `driver` is a closed set of ten values, hand-typed FOUR times, not three: independently in
 * `packages/runtime/src/driver.ts`'s `RuntimeDriverId` (spec §14.2), in this task's own Zod copy
 * in `packages/core/src/schemas.ts`, in this file's `runtimeProfileDrivers` below, AND — the copy
 * that is easy to miss — in the `CHECK` constraint text `drizzle-kit generate` compiled into
 * `migrations/0002_w3_runtime_profiles.sql` and that migration alone actually applies to a real
 * database. `packages/core` may not depend on `packages/runtime` (no manifest in this wave may
 * gain a dependency — ADR-0041) and a database CHECK cannot reference a TypeScript type, which is
 * why the first three are hand-typed rather than imported; the migration file is hand-typed for a
 * different reason — it is a generated artifact nothing re-generates or diffs in CI.
 *
 * `runtime-profiles.test.ts` (this file's sibling) pins all four. Its first `describe` pins this
 * package's two copies (`runtimeDriverIds`, `runtimeProfileDrivers`) to each other AND to
 * `docs/spec.md` §14.2's own union, read and parsed at test time — not to
 * `packages/runtime/src/driver.ts` directly, because `RuntimeDriverId` there is a `type`, not a
 * `const`, so there is no runtime value to import even without the ADR-0041 dependency ban.
 * `packages/runtime/src/spec-transcription.test.ts` pins `driver.ts` to the same spec text from its
 * side, so those three meet at `docs/spec.md`. Its second `describe` (W3-CP-06-B4, round 3) pins
 * the fourth: it parses `migrations/*.sql`'s committed `runtime_profiles_driver_valid` CHECK
 * constraint directly and compares it to `runtimeProfileDrivers` — not to the spec, since the
 * migration is a generated artifact of this file, not of the spec — closing the loop transitively.
 *
 * Round 2 added the first `describe` and believed it closed W3-CP-06-B4 by naming "three copies,
 * not one" here; it did not name the migration, so a driver added to the spec and to all three
 * TypeScript copies still reached a real database and failed with `23514` at a driver task's
 * integration — exactly the outcome B4 says must not happen (round-3 confirmer, measured against a
 * migrated PostgreSQL 17). The second `describe` is round 3's fix for that gap.
 */
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { integer, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { createdAt, primaryKeyId, updatedAt } from './columns.js';
import { oneOf } from './one-of.js';
import { secrets } from './secrets.js';
import { workspaces } from './workspaces.js';

/**
 * Spec §14.2's `RuntimeDriverId`, verbatim. See this file's header for why it is one of four
 * hand-typed copies rather than an import.
 */
export const runtimeProfileDrivers = [
  'local',
  'sandbox-runtime',
  'docker',
  'kubernetes',
  'gke-agent-sandbox',
  'aca-sessions',
  'aws-agentcore',
  'aws-ecs',
  'cloud-run-sandbox',
  'cloud-run-service',
  'external',
  'vercel-sandbox',
  'cloudflare-sandbox',
] as const;
export type RuntimeProfileDriver = (typeof runtimeProfileDrivers)[number];

/** Spec §15.1's `networkPolicy`. */
export const runtimeProfileNetworkPolicies = ['none', 'restricted', 'open'] as const;
export type RuntimeProfileNetworkPolicy = (typeof runtimeProfileNetworkPolicies)[number];

/** Spec §15.1's `filesystem`. */
export const runtimeProfileFilesystems = ['read-only', 'read-write'] as const;
export type RuntimeProfileFilesystem = (typeof runtimeProfileFilesystems)[number];

export const runtimeProfiles = pgTable(
  'runtime_profiles',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** §15.1 `name`. Unique within the workspace, matching every other named resource here. */
    name: text('name').notNull(),
    /** §15.1 `driver`. */
    driver: text('driver', { enum: runtimeProfileDrivers }).notNull(),
    /**
     * §15.1 `runtimeConnectionId`. `SET NULL` on delete: a revoked connection must not delete the
     * profiles that named it — it must leave them unable to select a runtime until reconfigured,
     * which is a visible, recoverable state (the same reasoning `agents.model_connection_id`
     * gives for the same action).
     */
    runtimeConnectionId: uuid('runtime_connection_id').references(() => secrets.id, {
      onDelete: 'set null',
    }),
    cpu: integer('cpu'),
    memoryMb: integer('memory_mb'),
    diskMb: integer('disk_mb'),
    /** §15.1 `networkPolicy`. */
    networkPolicy: text('network_policy', { enum: runtimeProfileNetworkPolicies }).notNull(),
    /** §15.1 `allowedDomains`. `null` means "not set", not "empty allowlist". */
    allowedDomains: jsonb('allowed_domains').$type<readonly string[]>(),
    /** §15.1 `filesystem`. */
    filesystem: text('filesystem', { enum: runtimeProfileFilesystems }).notNull(),
    persistPaths: jsonb('persist_paths').$type<readonly string[]>(),
    timeoutSeconds: integer('timeout_seconds'),
    idleTimeoutSeconds: integer('idle_timeout_seconds'),
    /** §15.1 `driverConfig`. See this file's header for why it is untyped here. */
    driverConfig: jsonb('driver_config').$type<Record<string, unknown>>(),
    /**
     * `true` on the workspace's default runtime profile, `NULL` on every other profile (issue
     * #504, S1-22). An agent version that names no runtime profile (`runtimeProfileName: null`)
     * resolves to this profile at the moment the version is applied, so the stored agent row
     * carries a concrete profile id and run preflight stays strict. A workspace with no profile
     * marked has chosen no default: an agent that names no profile then stays refused
     * (`agent_runtime_profile_missing`), and nothing is silently picked.
     *
     * The mark lives on the profile rather than as an id on `workspaces` so that it needs no
     * reference back from the tenant root (no schema cycle — the same choice
     * `agents.setup_configured_at` made), it can never name another workspace's profile, and a
     * deleted profile simply takes its mark with it. It is `true` or `NULL`, never `false`
     * (`runtime_profiles_workspace_default_true_or_null`), so the plain unique key
     * `runtime_profiles_workspace_default_key` on `(workspace_id, workspace_default)` allows at
     * most one marked profile per workspace while every unmarked one (`NULL`) stays distinct.
     */
    workspaceDefault: boolean('workspace_default'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('runtime_profiles_workspace_name_key').on(table.workspaceId, table.name),
    // The target `agents_runtime_profile_workspace_fk` needs — see agents.ts for why this is a
    // table CONSTRAINT and not a unique INDEX (drizzle-kit ordering).
    unique('runtime_profiles_id_workspace_key').on(table.id, table.workspaceId),
    // At most one default per workspace (issue #504); see `workspaceDefault` above.
    unique('runtime_profiles_workspace_default_key').on(table.workspaceId, table.workspaceDefault),
    index('runtime_profiles_runtime_connection_idx').on(table.runtimeConnectionId),
    // §25: a profile must not be able to select another workspace's runtime connection.
    foreignKey({
      columns: [table.runtimeConnectionId, table.workspaceId],
      foreignColumns: [secrets.id, secrets.workspaceId],
      name: 'runtime_profiles_runtime_connection_workspace_fk',
    }),
    check('runtime_profiles_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check(
      'runtime_profiles_workspace_default_true_or_null',
      sql`${table.workspaceDefault} is null or ${table.workspaceDefault}`,
    ),
    oneOf('runtime_profiles_driver_valid', table.driver, runtimeProfileDrivers),
    oneOf(
      'runtime_profiles_network_policy_valid',
      table.networkPolicy,
      runtimeProfileNetworkPolicies,
    ),
    oneOf('runtime_profiles_filesystem_valid', table.filesystem, runtimeProfileFilesystems),
  ],
);

export type RuntimeProfileRow = typeof runtimeProfiles.$inferSelect;
export type NewRuntimeProfileRow = typeof runtimeProfiles.$inferInsert;
