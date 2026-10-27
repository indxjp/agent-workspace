/**
 * `WorkspaceRepository`, against real PostgreSQL — issue #119's acceptance criteria, each proved
 * at the layer that owns them:
 *
 *   * "A user lists exactly workspaces with a current membership" → {@link listForUser}.
 *   * "Cross-workspace enumeration is prevented" → {@link getForMember} folds a foreign workspace
 *     and a nonexistent one into the identical `null`.
 *   * "Failed creation leaves no orphan workspace or membership" → the membership FK is made to
 *     fail (an owner id that names no `users` row) and the workspace row is asserted gone.
 *   * "Creation atomically creates an Owner membership … exactly one succeeds and the other gets a
 *     conflict, not a duplicate row" → two concurrent `create()` calls with the same slug.
 *   * Archive is non-destructive and idempotent; restore clears it.
 */
import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseWorkspaceRepository, isWorkspaceArchived } from './workspaces.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describe.skipIf(!hasDatabase)('WorkspaceRepository', () => {
  let isolated: IsolatedTestDatabase;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_workspaces');
  }, 180_000);

  afterAll(async () => isolated.close());

  async function insertUser(name: string): Promise<string> {
    const id = crypto.randomUUID();
    await isolated.db.insert(users).values({ id, email: `${id}@example.com`, name });
    return id;
  }

  it('creates a workspace and its creator Owner membership in one transaction', async () => {
    const repository = createDatabaseWorkspaceRepository(isolated.db);
    const ownerUserId = await insertUser('Creator');
    const slug = `acme-${crypto.randomUUID()}`;

    const outcome = await repository.create({ name: 'Acme', slug, ownerUserId });
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'created') throw new Error('unreachable');
    expect(outcome.workspace.slug).toBe(slug);
    expect(isWorkspaceArchived(outcome.workspace)).toBe(false);

    const membershipRows = await isolated.db
      .select()
      .from(memberships)
      .where(eq(memberships.workspaceId, outcome.workspace.id));
    expect(membershipRows).toHaveLength(1);
    expect(membershipRows[0]?.userId).toBe(ownerUserId);
    expect(membershipRows[0]?.role).toBe('owner');
    const principalRows = await isolated.db
      .select()
      .from(workspacePrincipals)
      .where(eq(workspacePrincipals.membershipId, membershipRows[0]?.id ?? ''));
    expect(principalRows).toEqual([
      expect.objectContaining({
        workspaceId: outcome.workspace.id,
        kind: 'membership',
        membershipId: membershipRows[0]?.id,
        apiKeyId: null,
      }),
    ]);
  });

  it('normalises the slug before the unique and format constraints see it', async () => {
    const repository = createDatabaseWorkspaceRepository(isolated.db);
    const ownerUserId = await insertUser('Normaliser');
    const raw = `Mixed-${crypto.randomUUID()}`;

    const created = await repository.create({ name: 'Mixed Case', slug: raw, ownerUserId });
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') throw new Error('unreachable');
    expect(created.workspace.slug).toBe(raw.trim().toLowerCase());

    // A second caller spelling the same slug differently collides as the same `conflict`, not a
    // second row (the card's amendment: "a normalised duplicate is the same conflict outcome as
    // an exact one").
    const secondOwner = await insertUser('Collider');
    const collision = await repository.create({
      name: 'Different Name',
      slug: raw.toUpperCase(),
      ownerUserId: secondOwner,
    });
    expect(collision).toEqual({ kind: 'conflict', slug: raw.trim().toLowerCase() });
  });

  it('leaves no orphan workspace when the membership insert fails', async () => {
    const repository = createDatabaseWorkspaceRepository(isolated.db);
    const slug = `orphan-${crypto.randomUUID()}`;
    // An owner id that names no `users` row: `memberships.user_id`'s foreign key rejects the
    // insert, which must roll the workspace insert back with it rather than leaving a tenant row
    // with no Owner (issue #119: "Failed creation leaves no orphan workspace or membership").
    const nonExistentUserId = crypto.randomUUID();

    await expect(
      repository.create({ name: 'Orphan', slug, ownerUserId: nonExistentUserId }),
    ).rejects.toThrow();

    const rows = await isolated.db.select().from(workspaces).where(eq(workspaces.slug, slug));
    expect(rows).toHaveLength(0);
  });

  it('lets exactly one of two concurrent same-slug creates succeed', async () => {
    const repository = createDatabaseWorkspaceRepository(isolated.db);
    const slug = `race-${crypto.randomUUID()}`;
    const [firstOwner, secondOwner] = await Promise.all([
      insertUser('Racer One'),
      insertUser('Racer Two'),
    ]);

    const [first, second] = await Promise.all([
      repository.create({ name: 'Race First', slug, ownerUserId: firstOwner }),
      repository.create({ name: 'Race Second', slug, ownerUserId: secondOwner }),
    ]);

    const outcomes = [first.kind, second.kind].sort();
    expect(outcomes).toEqual(['conflict', 'created']);

    const rows = await isolated.db.select().from(workspaces).where(eq(workspaces.slug, slug));
    expect(rows).toHaveLength(1);
    // Exactly one membership was created for the winning workspace — the loser's membership
    // insert never ran, because its workspace insert never committed.
    const memberRows = await isolated.db
      .select()
      .from(memberships)
      .where(eq(memberships.workspaceId, rows[0]!.id));
    expect(memberRows).toHaveLength(1);
  });

  it('lists exactly the workspaces a user currently belongs to, and no others', async () => {
    const repository = createDatabaseWorkspaceRepository(isolated.db);
    const userId = await insertUser('Lister');
    const outsider = await insertUser('Outsider');

    const a = await repository.create({
      name: 'A',
      slug: `a-${crypto.randomUUID()}`,
      ownerUserId: userId,
    });
    const b = await repository.create({
      name: 'B',
      slug: `b-${crypto.randomUUID()}`,
      ownerUserId: userId,
    });
    const c = await repository.create({
      name: 'C',
      slug: `c-${crypto.randomUUID()}`,
      ownerUserId: outsider,
    });
    if (a.kind !== 'created' || b.kind !== 'created' || c.kind !== 'created') {
      throw new Error('setup failed');
    }

    const listed = await repository.listForUser(userId);
    const ids = listed.map((row) => row.id).sort();
    expect(ids).toEqual([a.workspace.id, b.workspace.id].sort());
    expect(ids).not.toContain(c.workspace.id);
    expect(listed.every((row) => row.role === 'owner')).toBe(true);
  });

  it('folds a foreign workspace and a nonexistent one into the identical null', async () => {
    const repository = createDatabaseWorkspaceRepository(isolated.db);
    const memberUserId = await insertUser('Member');
    const strangerUserId = await insertUser('Stranger');
    const created = await repository.create({
      name: 'Private',
      slug: `private-${crypto.randomUUID()}`,
      ownerUserId: memberUserId,
    });
    if (created.kind !== 'created') throw new Error('setup failed');

    const foreign = await repository.getForMember(created.workspace.id, strangerUserId);
    const nonexistent = await repository.getForMember(crypto.randomUUID(), strangerUserId);
    expect(foreign).toBeNull();
    expect(nonexistent).toBeNull();

    const own = await repository.getForMember(created.workspace.id, memberUserId);
    expect(own?.id).toBe(created.workspace.id);
    expect(own?.role).toBe('owner');
  });

  it('renames without touching the slug', async () => {
    const repository = createDatabaseWorkspaceRepository(isolated.db);
    const ownerUserId = await insertUser('Renamer');
    const created = await repository.create({
      name: 'Old Name',
      slug: `rename-${crypto.randomUUID()}`,
      ownerUserId,
    });
    if (created.kind !== 'created') throw new Error('setup failed');

    const updated = await repository.update(created.workspace.id, { name: 'New Name' });
    expect(updated?.name).toBe('New Name');
    expect(updated?.slug).toBe(created.workspace.slug);
  });

  it('archives idempotently and restore clears it', async () => {
    const repository = createDatabaseWorkspaceRepository(isolated.db);
    const ownerUserId = await insertUser('Archiver');
    const created = await repository.create({
      name: 'Archivable',
      slug: `archive-${crypto.randomUUID()}`,
      ownerUserId,
    });
    if (created.kind !== 'created') throw new Error('setup failed');

    const archived = await repository.archive(created.workspace.id);
    expect(isWorkspaceArchived(archived!)).toBe(true);
    const firstTimestamp = archived!.archivedAt;

    // Idempotent: archiving an already-archived workspace keeps the first timestamp.
    const archivedAgain = await repository.archive(created.workspace.id);
    expect(archivedAgain?.archivedAt?.getTime()).toBe(firstTimestamp?.getTime());

    const restored = await repository.restore(created.workspace.id);
    expect(isWorkspaceArchived(restored!)).toBe(false);

    // The row is still readable, archived or not (issue #119: "Archive is non-destructive,
    // visible"). Re-archive to check `get` still answers for an archived workspace too.
    await repository.archive(created.workspace.id);
    const stillReadable = await repository.get(created.workspace.id);
    expect(stillReadable).not.toBeNull();
    expect(isWorkspaceArchived(stillReadable!)).toBe(true);
  });

  it('returns null from every mutator for an id that does not exist', async () => {
    const repository = createDatabaseWorkspaceRepository(isolated.db);
    const missing = crypto.randomUUID();
    await expect(repository.update(missing, { name: 'X' })).resolves.toBeNull();
    await expect(repository.archive(missing)).resolves.toBeNull();
    await expect(repository.restore(missing)).resolves.toBeNull();
    await expect(repository.get(missing)).resolves.toBeNull();
  });

  it('answers the earliest owner principal, and null for a workspace that does not exist', async () => {
    const repository = createDatabaseWorkspaceRepository(isolated.db);
    const created = await repository.create({
      name: 'Owned',
      slug: `owned-${crypto.randomUUID()}`,
      ownerUserId: await insertUser('First owner'),
    });
    if (created.kind !== 'created') throw new Error('setup failed');
    const [ownerPrincipal] = await isolated.db
      .select({ id: workspacePrincipals.id })
      .from(workspacePrincipals)
      .where(eq(workspacePrincipals.workspaceId, created.workspace.id));
    if (ownerPrincipal === undefined) throw new Error('setup failed');

    // A later owner and a later viewer, each with a live principal, never take over.
    const later = new Date(Date.now() + 60_000);
    const laterPrincipals = new Map<string, string | undefined>();
    for (const role of ['owner', 'viewer'] as const) {
      const [membership] = await isolated.db
        .insert(memberships)
        .values({
          workspaceId: created.workspace.id,
          userId: await insertUser(`Later ${role}`),
          role,
          createdAt: later,
        })
        .returning({ id: memberships.id });
      if (membership === undefined) throw new Error('setup failed');
      // The membership insert creates its principal.
      const [principal] = await isolated.db
        .select({ id: workspacePrincipals.id })
        .from(workspacePrincipals)
        .where(eq(workspacePrincipals.membershipId, membership.id));
      laterPrincipals.set(role, principal?.id);
    }

    await expect(repository.ownerPrincipalId(created.workspace.id)).resolves.toBe(
      ownerPrincipal.id,
    );

    // A revoked earliest owner falls through to the next owner, never to the viewer.
    await isolated.db
      .update(workspacePrincipals)
      .set({ revokedAt: new Date() })
      .where(eq(workspacePrincipals.id, ownerPrincipal.id));
    await expect(repository.ownerPrincipalId(created.workspace.id)).resolves.toBe(
      laterPrincipals.get('owner'),
    );
    await expect(repository.ownerPrincipalId(crypto.randomUUID())).resolves.toBeNull();
  });
});
