/**
 * `WorkspaceRepository` — issue #119's CRUD/listing surface over the tenant root itself.
 *
 * ## Why this repository is not `forScope`-shaped
 *
 * Every other repository in this directory is obtained *for a {@link
 * import('./scope.js').WorkspaceScope}* because every other table carries a `workspace_id` that
 * scopes it. `workspaces` is one of the two tables that has none — this row IS the workspace (see
 * `../schema/workspaces.ts`'s header) — so there is nothing to scope by, and `root.ts` exposes this
 * repository directly on {@link import('./root.js').DatabaseRoot} rather than behind a
 * `.forScope(...)` call, the same shape `directory.ts` already uses for the same reason.
 *
 * ## What "own" means for a resource that IS the tenant
 *
 * A member's caller-visible identity here is `users.id`, never `workspaces.id` itself and never an
 * email (ADR-W9-AUTH-117 gives the reasons an email is not a durable ownership key). Every method
 * below that answers "does this caller reach this workspace" therefore takes a `userId` and joins
 * through `memberships`, and {@link getForMember} folds "the workspace does not exist" and "the
 * caller is not a member of it" into the identical `null` — the concealment issue #117 already
 * established for item ownership, applied here to the tenant row itself: `#119`'s "cross-workspace
 * enumeration is prevented" means a foreign workspace id and a nonexistent one must be
 * indistinguishable from this repository's answer alone.
 *
 * ## Slug normalisation lives here, not at the HTTP edge
 *
 * `workspaces_slug_key` (unique) and `workspaces_slug_format` (CHECK) already exist on `main`
 * (`docs/adr/W9-PLAN-the-composition-root-moved-after-the-plan-was-written.md` §4), so this
 * migration adds only `archived_at`. {@link create} trims and lower-cases the caller's slug before
 * either constraint sees it, so `"Acme"` and `"acme"` collide as the same `conflict` outcome
 * rather than passing the format check twice and landing two rows that only differ by case.
 */
import { and, asc, eq, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { memberships, type MembershipRole } from '../schema/memberships.js';
import { workspaces } from '../schema/workspaces.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { postgresViolations } from './violations.js';

/** One `workspaces` row, `timestamptz` columns as `Date`. */
export interface WorkspaceRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly publicSharingEnabled: boolean;
  /** `null` while active; see `../schema/workspaces.ts`'s header on the archive lifecycle. */
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A workspace, joined to the role the caller in question holds in it.
 *
 * Not exported from this package's public barrel (`packages/core/src/db/index.ts`, out of this
 * task's `Owns`; see `docs/adr/W9-WS-119-workspace-resource-authorisation-and-lifecycle.md`), so
 * `apps/web/server/workspaces/**` reaches this shape structurally, off
 * `DatabaseRoot['workspaces']`, rather than by importing the name — this stays unexported
 * (`knip`'s deadcode gate otherwise reports it as a dead export) but is still part of {@link
 * WorkspaceRepository}'s public method signatures below, which TypeScript is free to reference by
 * structural shape without the referenced interface itself needing to be exported.
 */
interface WorkspaceMembershipView extends WorkspaceRecord {
  readonly role: MembershipRole;
}

/** See {@link WorkspaceMembershipView}'s comment on why this stays unexported. */
interface CreateWorkspaceInput {
  readonly name: string;
  readonly slug: string;
  /** `memberships.user_id` of the caller, stamped as this workspace's sole Owner. */
  readonly ownerUserId: string;
}

/**
 * Creating a workspace, and every correction the caller can make.
 *
 * `conflict` covers both an exact duplicate and a normalised one (this file's header) — the
 * caller cannot tell the two apart from outside, and a `409` naming the slug is the same
 * correction either way: choose a different one. `invalid-slug`/`invalid-name` are the schema's
 * own CHECK constraints, reached only if a caller bypasses HTTP-edge validation, since the
 * `workspaces_slug_format` and `workspaces_name_not_blank` checks already exist on `main`.
 */
type CreateWorkspaceOutcome =
  | { readonly kind: 'created'; readonly workspace: WorkspaceRecord }
  | { readonly kind: 'conflict'; readonly slug: string }
  | { readonly kind: 'invalid-slug'; readonly slug: string }
  | { readonly kind: 'invalid-name' };

/**
 * Rename only. Settings beyond name are out of this wave's scope (card's "Deliberately not
 * built"). See {@link WorkspaceMembershipView}'s comment on why this stays unexported.
 */
type UpdateWorkspacePatch = Partial<Pick<WorkspaceRecord, 'name'>>;

export interface WorkspaceRepository {
  /** Every workspace `userId` currently belongs to, with their role in each. Issue #119. */
  listForUser(userId: string): Promise<readonly WorkspaceMembershipView[]>;
  /**
   * One workspace by id alone, with no membership check — for callers that already established
   * the caller's right to see it some other way (a composition-root run/session gate reading
   * `archivedAt`, an internal maintenance job). Route handlers reach this table through
   * {@link getForMember} instead, never this method, so a route can never become an oracle for a
   * workspace's existence outside the caller's own memberships.
   */
  get(id: string): Promise<WorkspaceRecord | null>;
  /**
   * One workspace by id, folded with "does `userId` currently belong to it" — `null` for a
   * nonexistent workspace and for one `userId` does not belong to, indistinguishably (issue #117's
   * concealment rule, applied to the tenant row itself).
   */
  getForMember(id: string, userId: string): Promise<WorkspaceMembershipView | null>;
  /**
   * Insert the workspace and its creator's Owner membership in one transaction: a membership
   * insert that fails leaves no workspace row, and a workspace insert that fails leaves no
   * membership (issue #119's "failed creation leaves no orphan workspace or membership").
   */
  create(input: CreateWorkspaceInput): Promise<CreateWorkspaceOutcome>;
  /** Rename. `null` if `id` does not exist. Slug changes are a separate operation (not built). */
  update(id: string, patch: UpdateWorkspacePatch): Promise<WorkspaceRecord | null>;
  /**
   * Set `archivedAt` to now, unless it is already set (idempotent: archiving twice keeps the
   * first timestamp rather than moving it forward). `null` if `id` does not exist.
   */
  archive(id: string): Promise<WorkspaceRecord | null>;
  /** Clear `archivedAt`. `null` if `id` does not exist. Idempotent on an already-active workspace. */
  restore(id: string): Promise<WorkspaceRecord | null>;
}

function normaliseSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

function isConstraint(error: unknown, constraint: string): boolean {
  for (const violation of postgresViolations(error)) {
    if (violation.constraint === constraint) return true;
  }
  return false;
}

const WORKSPACE_COLUMNS = {
  id: workspaces.id,
  slug: workspaces.slug,
  name: workspaces.name,
  publicSharingEnabled: workspaces.publicSharingEnabled,
  archivedAt: workspaces.archivedAt,
  createdAt: workspaces.createdAt,
  updatedAt: workspaces.updatedAt,
} as const;

export function createDatabaseWorkspaceRepository(db: Database): WorkspaceRepository {
  return {
    async listForUser(userId) {
      return db
        .select({ ...WORKSPACE_COLUMNS, role: memberships.role })
        .from(memberships)
        .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
        .where(eq(memberships.userId, userId))
        .orderBy(asc(workspaces.name));
    },
    async get(id) {
      const rows = await db
        .select(WORKSPACE_COLUMNS)
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .limit(1);
      return rows[0] ?? null;
    },
    async getForMember(id, userId) {
      const rows = await db
        .select({ ...WORKSPACE_COLUMNS, role: memberships.role })
        .from(memberships)
        .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
        .where(and(eq(workspaces.id, id), eq(memberships.userId, userId)))
        .limit(1);
      return rows[0] ?? null;
    },
    async create(input) {
      const slug = normaliseSlug(input.slug);
      const name = input.name.trim();
      try {
        return await db.transaction(async (tx) => {
          const inserted = await tx
            .insert(workspaces)
            .values({ slug, name })
            .returning(WORKSPACE_COLUMNS);
          const workspace = inserted[0];
          if (workspace === undefined) throw new Error('workspace insert returned no row');
          const insertedMembership = await tx
            .insert(memberships)
            .values({ workspaceId: workspace.id, userId: input.ownerUserId, role: 'owner' })
            .returning({ id: memberships.id });
          const membership = insertedMembership[0];
          if (membership === undefined) {
            throw new Error('owner membership insert returned no row');
          }
          const insertedPrincipal = await tx
            .insert(workspacePrincipals)
            .values({
              workspaceId: workspace.id,
              kind: 'membership',
              membershipId: membership.id,
            })
            .returning({ id: workspacePrincipals.id });
          if (insertedPrincipal[0] === undefined) {
            throw new Error('owner principal insert returned no row');
          }
          return { kind: 'created' as const, workspace };
        });
      } catch (error) {
        if (isConstraint(error, 'workspaces_slug_key')) return { kind: 'conflict', slug };
        if (isConstraint(error, 'workspaces_slug_format')) return { kind: 'invalid-slug', slug };
        if (isConstraint(error, 'workspaces_name_not_blank')) return { kind: 'invalid-name' };
        throw error;
      }
    },
    async update(id, patch) {
      if (Object.keys(patch).length === 0) return this.get(id);
      const rows = await db
        .update(workspaces)
        .set(patch)
        .where(eq(workspaces.id, id))
        .returning(WORKSPACE_COLUMNS);
      return rows[0] ?? null;
    },
    async archive(id) {
      const rows = await db
        .update(workspaces)
        // `coalesce` rather than an unconditional `now()`: archiving an already-archived
        // workspace is a no-op restore-preserving idempotent write, never a moved timestamp.
        .set({ archivedAt: sql`coalesce(${workspaces.archivedAt}, now())` })
        .where(eq(workspaces.id, id))
        .returning(WORKSPACE_COLUMNS);
      return rows[0] ?? null;
    },
    async restore(id) {
      const rows = await db
        .update(workspaces)
        .set({ archivedAt: null })
        .where(eq(workspaces.id, id))
        .returning(WORKSPACE_COLUMNS);
      return rows[0] ?? null;
    },
  };
}

/** Whether a workspace is archived — the one predicate every reader of `archivedAt` should share. */
export function isWorkspaceArchived(workspace: Pick<WorkspaceRecord, 'archivedAt'>): boolean {
  return workspace.archivedAt !== null;
}
