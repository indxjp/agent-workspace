/**
 * An in-memory {@link WorkspaceRepositoryPort}, for the route-level suites under
 * `apps/web/app/api/workspaces/**` and `apps/web/server/workspaces/**` that must not need
 * `TEST_DATABASE_URL` to run (`pnpm vitest run` with no database, per the card's acceptance
 * commands).
 *
 * This is not a stub: it enforces the same two invariants the real
 * `packages/core/src/db/repositories/workspaces.ts` enforces — slug normalisation before the
 * uniqueness check, and "the membership insert can fail and the workspace insert rolls back with
 * it" — via {@link CreateMemoryWorkspaceRepositoryOptions.beforeMembershipInsert}, so a route-level
 * test can prove issue #119's "failed creation leaves no orphan workspace" the same way
 * `packages/core/src/db/repositories/workspaces.test.ts` proves it against real PostgreSQL.
 */
import type { Role } from '../rbac/roles';
import type { WorkspaceRepositoryPort } from './runtime';

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  publicSharingEnabled: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MembershipRow {
  workspaceId: string;
  userId: string;
  role: Role;
}

export interface SeedMemoryWorkspace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly archivedAt?: Date | null;
  readonly members: readonly { readonly userId: string; readonly role: Role }[];
}

export interface CreateMemoryWorkspaceRepositoryOptions {
  readonly workspaces?: readonly SeedMemoryWorkspace[];
  readonly now?: () => Date;
  readonly newId?: () => string;
  /**
   * Called synchronously at the point `create()`'s transaction would insert the Owner membership.
   * Throw from it to simulate that insert failing (a bad foreign key, in the real repository) and
   * assert afterwards that no workspace row with the attempted slug exists.
   */
  readonly beforeMembershipInsert?: () => void;
}

function normaliseSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

const SLUG_FORMAT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function createMemoryWorkspaceRepository(
  options: CreateMemoryWorkspaceRepositoryOptions = {},
): WorkspaceRepositoryPort {
  const now = options.now ?? ((): Date => new Date());
  let counter = 0;
  const newId = options.newId ?? ((): string => `workspace-${String((counter += 1))}`);

  const rows = new Map<string, WorkspaceRow>();
  const members = new Map<string, MembershipRow[]>(); // keyed by workspaceId

  for (const seed of options.workspaces ?? []) {
    rows.set(seed.id, {
      id: seed.id,
      slug: seed.slug,
      name: seed.name,
      publicSharingEnabled: true,
      archivedAt: seed.archivedAt ?? null,
      createdAt: now(),
      updatedAt: now(),
    });
    members.set(
      seed.id,
      seed.members.map((member) => ({
        workspaceId: seed.id,
        userId: member.userId,
        role: member.role,
      })),
    );
  }

  function membershipRole(workspaceId: string, userId: string): Role | null {
    return (members.get(workspaceId) ?? []).find((row) => row.userId === userId)?.role ?? null;
  }

  return {
    ownerPrincipalId: () => Promise.resolve(null),
    listForUser(userId) {
      const out: (WorkspaceRow & { role: Role })[] = [];
      for (const row of rows.values()) {
        const role = membershipRole(row.id, userId);
        if (role !== null) out.push({ ...row, role });
      }
      return Promise.resolve(out.sort((a, b) => a.name.localeCompare(b.name)));
    },
    get(id) {
      return Promise.resolve(rows.get(id) ?? null);
    },
    getForMember(id, userId) {
      const row = rows.get(id);
      if (row === undefined) return Promise.resolve(null);
      const role = membershipRole(id, userId);
      return Promise.resolve(role === null ? null : { ...row, role });
    },
    async create(input) {
      const slug = normaliseSlug(input.slug);
      const name = input.name.trim();
      if (name === '') return { kind: 'invalid-name' };
      if (!SLUG_FORMAT.test(slug)) return { kind: 'invalid-slug', slug };
      for (const row of rows.values()) {
        if (row.slug === slug) return { kind: 'conflict', slug };
      }
      const id = newId();
      const timestamp = now();
      // The transactional half: a membership-insert failure must not leave the workspace row
      // behind. Nothing is written to `rows`/`members` until both steps below succeed, and the
      // real `await` below turns a synchronous throw from the hook into a rejected promise, the
      // same shape a real failed `INSERT` inside a transaction rejects with.
      await Promise.resolve(options.beforeMembershipInsert?.());
      const workspace: WorkspaceRow = {
        id,
        slug,
        name,
        publicSharingEnabled: true,
        archivedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      rows.set(id, workspace);
      members.set(id, [{ workspaceId: id, userId: input.ownerUserId, role: 'owner' }]);
      return { kind: 'created', workspace };
    },
    update(id, patch) {
      const row = rows.get(id);
      if (row === undefined) return Promise.resolve(null);
      const updated = { ...row, ...patch, updatedAt: now() };
      rows.set(id, updated);
      return Promise.resolve(updated);
    },
    archive(id) {
      const row = rows.get(id);
      if (row === undefined) return Promise.resolve(null);
      const updated = { ...row, archivedAt: row.archivedAt ?? now(), updatedAt: now() };
      rows.set(id, updated);
      return Promise.resolve(updated);
    },
    restore(id) {
      const row = rows.get(id);
      if (row === undefined) return Promise.resolve(null);
      const updated = { ...row, archivedAt: null, updatedAt: now() };
      rows.set(id, updated);
      return Promise.resolve(updated);
    },
  };
}
