import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { demoDailyCosts } from '../schema/demo-daily-costs.js';
import { demoRunAdmissions } from '../schema/demo-run-admissions.js';
import { loginTokens } from '../schema/login-tokens.js';
import { mcpServers } from '../schema/mcp-servers.js';
import { memberships } from '../schema/memberships.js';
import {
  SECRET_NONCE_BYTES,
  SECRET_TAG_BYTES,
  SECRET_WRAPPED_DATA_KEY_BYTES,
  secrets,
} from '../schema/secrets.js';
import { storeLeads } from '../schema/store-leads.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { runs } from '../schema/runs.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseDemoSweepRepository } from './demo-sweep.js';
import { insertDemoWorkspace } from './demo-workspace.test-support.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn(
    '[repositories/demo-sweep.postgres.test.ts] SKIPPED — TEST_DATABASE_URL is not set.',
  );
}

const HOUR_MS = 60 * 60 * 1000;
const T0 = new Date('2026-11-16T10:00:00.000Z');
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR_MS);
const hex = (char: string) => char.repeat(64);

describe.skipIf(!hasDatabase)('migration 0107: the demo sweep repository', () => {
  let isolated: IsolatedTestDatabase;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_demo_sweep');
  }, 180_000);
  afterAll(async () => isolated.close());

  const sweep = () => createDatabaseDemoSweepRepository(isolated.db);
  const exists = async (workspaceId: string) =>
    (
      await isolated.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
    ).length === 1;

  it('lists the demo workspaces at or past their end, oldest first, and no real workspace', async () => {
    const created = at(-48);
    const later = await insertDemoWorkspace(isolated, {
      createdAt: created,
      demoExpiresAt: at(-1),
    });
    const earlier = await insertDemoWorkspace(isolated, {
      createdAt: created,
      demoExpiresAt: at(-2),
    });
    const atEnd = await insertDemoWorkspace(isolated, { createdAt: created, demoExpiresAt: T0 });
    const before = await insertDemoWorkspace(isolated, {
      createdAt: created,
      demoExpiresAt: at(1),
    });
    const real = await insertDemoWorkspace(isolated, { createdAt: created, demoExpiresAt: null });
    const ids = await sweep().expiredWorkspaceIds(T0, 100);
    expect(ids).toEqual(
      expect.arrayContaining([earlier.workspaceId, later.workspaceId, atEnd.workspaceId]),
    );
    expect(ids.indexOf(earlier.workspaceId)).toBeLessThan(ids.indexOf(later.workspaceId));
    expect(ids).not.toContain(before.workspaceId);
    expect(ids).not.toContain(real.workspaceId);
    expect(await sweep().expiredWorkspaceIds(T0, 1)).toHaveLength(1);
  });

  it('deletes an expired workspace with everything in it, at and after its end', async () => {
    const demo = await insertDemoWorkspace(isolated, { createdAt: at(-30), demoExpiresAt: T0 });
    await demo.addUsage({ costUsd: '1.000000', at: at(-5) });
    expect(await sweep().deleteExpiredWorkspace(demo.workspaceId, T0)).toBe(true);
    expect(await exists(demo.workspaceId)).toBe(false);
    expect(
      await isolated.db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.workspaceId, demo.workspaceId)),
    ).toEqual([]);
    expect(
      await isolated.db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.workspaceId, demo.workspaceId)),
    ).toEqual([]);
  });

  it('keeps a demo workspace before its end and never deletes a real one', async () => {
    const before = await insertDemoWorkspace(isolated, {
      createdAt: at(-30),
      demoExpiresAt: at(1),
    });
    const real = await insertDemoWorkspace(isolated, { createdAt: at(-30), demoExpiresAt: null });
    expect(await sweep().deleteExpiredWorkspace(before.workspaceId, T0)).toBe(false);
    expect(await sweep().deleteExpiredWorkspace(real.workspaceId, at(1000))).toBe(false);
    expect(await exists(before.workspaceId)).toBe(true);
    expect(await exists(real.workspaceId)).toBe(true);
  });

  it('carries the deleted workspace spend into demo_daily_costs, per UTC day, and adds to a day already carried', async () => {
    await isolated.db.delete(demoDailyCosts);
    await isolated.db
      .insert(demoDailyCosts)
      .values({ day: '2026-11-16', costUsd: '0.500000', updatedAt: at(-20) });
    const demo = await insertDemoWorkspace(isolated, { createdAt: at(-40), demoExpiresAt: T0 });
    await demo.addUsage({ costUsd: '1.250000', at: new Date('2026-11-16T01:00:00Z') });
    await demo.addUsage({ costUsd: '2.000000', at: new Date('2026-11-16T09:00:00Z') });
    await demo.addUsage({ costUsd: '4.000000', at: new Date('2026-11-15T23:59:59Z') });
    expect(await sweep().deleteExpiredWorkspace(demo.workspaceId, T0)).toBe(true);
    const days = await isolated.db.select().from(demoDailyCosts).orderBy(demoDailyCosts.day);
    expect(days.map((row) => [row.day, Number(row.costUsd), row.unpricedUsage])).toEqual([
      ['2026-11-15', 4, false],
      ['2026-11-16', 3.75, false],
    ]);
  });

  it('marks the carried day unpriced when a run settlement failed, and carries it once', async () => {
    await isolated.db.delete(demoDailyCosts);
    const demo = await insertDemoWorkspace(isolated, { createdAt: at(-40), demoExpiresAt: T0 });
    await demo.addUsage({ costUsd: '0', at: at(-3), accounting: 'failed' });
    expect(await sweep().deleteExpiredWorkspace(demo.workspaceId, T0)).toBe(true);
    // A second sweep finds no workspace: nothing is carried twice.
    expect(await sweep().deleteExpiredWorkspace(demo.workspaceId, T0)).toBe(false);
    const days = await isolated.db.select().from(demoDailyCosts);
    expect(days.map((row) => [row.day, row.unpricedUsage])).toEqual([['2026-11-16', true]]);
  });

  it('is safe against the workspace table: every foreign key to it deletes with it', async () => {
    const result = await isolated.db.execute<{ child: string; action: string }>(sql`
      select conrelid::regclass::text as child, confdeltype::text as action
      from pg_constraint
      where contype = 'f' and confrelid = 'public.workspaces'::regclass and confdeltype not in ('c')
    `);
    // `set null` is allowed only where the column is nullable and the row belongs to no one else.
    expect(result.rows).toEqual([]);
  });

  it('deletes a workspace whose connector holds a secret: the connector goes before the secret', async () => {
    const demo = await insertDemoWorkspace(isolated, { createdAt: at(-30), demoExpiresAt: T0 });
    const [principal] = await isolated.db
      .select({ id: workspacePrincipals.id })
      .from(workspacePrincipals)
      .where(eq(workspacePrincipals.workspaceId, demo.workspaceId));
    if (principal === undefined) throw new Error('the fixture has no principal');
    const [secret] = await isolated.db
      .insert(secrets)
      .values({
        workspaceId: demo.workspaceId,
        name: 'DEMO_CONNECTOR_TOKEN',
        algorithm: 'aes-256-gcm',
        masterKeyId: 'test-key',
        wrappedDataKey: Buffer.alloc(SECRET_WRAPPED_DATA_KEY_BYTES, 1),
        wrappedDataKeyNonce: Buffer.alloc(SECRET_NONCE_BYTES, 2),
        wrappedDataKeyTag: Buffer.alloc(SECRET_TAG_BYTES, 3),
        ciphertext: Buffer.alloc(8, 4),
        ciphertextNonce: Buffer.alloc(SECRET_NONCE_BYTES, 5),
        ciphertextTag: Buffer.alloc(SECRET_TAG_BYTES, 6),
      })
      .returning({ id: secrets.id });
    if (secret === undefined) throw new Error('the secret insert returned no row');
    await isolated.db.insert(mcpServers).values({
      workspaceId: demo.workspaceId,
      name: 'Credentialed connector',
      transport: 'http',
      url: 'https://mcp.example.test/demo',
      authType: 'bearer',
      credentialSecretId: secret.id,
      ownerPrincipalId: principal.id,
    });
    expect(await sweep().deleteExpiredWorkspace(demo.workspaceId, T0)).toBe(true);
    expect(await exists(demo.workspaceId)).toBe(false);
    expect(
      await isolated.db.select({ id: secrets.id }).from(secrets).where(eq(secrets.id, secret.id)),
    ).toEqual([]);
  });

  it('has no RESTRICT foreign key between the tables a workspace delete reaches, but the one it handles', async () => {
    // The tables that cascade from `workspaces`, transitively; then every RESTRICT foreign key
    // between two of them. RESTRICT is checked the moment its parent row goes, whatever order the
    // cascade reaches the tables in (NO ACTION waits for the statement's end, which the cascade
    // satisfies), so each such key must be handled in `deleteExpiredWorkspace`.
    const result = await isolated.db.execute<{ name: string }>(sql`
      with recursive reached(oid) as (
        select 'public.workspaces'::regclass::oid
        union
        select c.conrelid from pg_constraint c join reached r on c.confrelid = r.oid
        where c.contype = 'f' and c.confdeltype = 'c'
      )
      select c.conname as name
      from pg_constraint c
      where c.contype = 'f'
        and c.confdeltype = 'r'
        and c.confrelid in (select oid from reached where oid <> 'public.workspaces'::regclass::oid)
        and c.conrelid in (select oid from reached)
      order by c.conname
    `);
    // Handled by deleting the connectors first.
    expect(result.rows.map((row) => row.name)).toEqual([
      'mcp_servers_credential_secret_workspace_fk',
    ]);
  });

  it('deletes the guest users nothing holds: no membership, no admission in the look-back', async () => {
    await isolated.db.delete(demoRunAdmissions);
    const make = async (label: string, createdAt: Date, lead = true) => {
      const email = `${label}-${crypto.randomUUID()}@example.test`;
      const [row] = await isolated.db
        .insert(users)
        .values({ email, name: label, createdAt })
        .returning({ id: users.id });
      if (row === undefined) throw new Error('the user insert returned no row');
      // An email link records the address as a lead; only such a user is a guest the sweep deletes.
      if (lead) {
        await isolated.db.insert(storeLeads).values({ email, createdAt, lastContactAt: createdAt });
      }
      return row.id;
    };
    const notAGuest = await make('admin-created', at(-72), false);
    const idle = await make('idle', at(-72));
    const recent = await make('recent', at(-1));
    const admitted = await make('admitted', at(-72));
    await isolated.db
      .insert(demoRunAdmissions)
      .values({ userId: admitted, clientKey: 'k', createdAt: at(-2) });
    const member = await insertDemoWorkspace(isolated, { createdAt: at(-72), demoExpiresAt: null });
    await isolated.db
      .update(users)
      .set({ createdAt: at(-72) })
      .where(eq(users.id, member.userId));
    const present = async (id: string) =>
      (await isolated.db.select({ id: users.id }).from(users).where(eq(users.id, id))).length === 1;

    await sweep().deleteIdleGuestUsersBefore(at(-24));
    expect(await present(idle)).toBe(false);
    expect(await present(recent)).toBe(true);
    expect(await present(admitted)).toBe(true);
    expect(await present(member.userId)).toBe(true);

    // Once the admission is pruned the person's cap has nothing left to lose.
    await sweep().deleteAdmissionsBefore(at(0));
    await sweep().deleteIdleGuestUsersBefore(at(0));
    expect(await present(admitted)).toBe(false);
    expect(await present(recent)).toBe(false);
    expect(await present(member.userId)).toBe(true);
    expect(await present(notAGuest)).toBe(true);
    expect(await isolated.db.select({ id: memberships.id }).from(memberships)).not.toEqual([]);
  });

  it('deletes login tokens that expired or were used before the cutoff, and no live token', async () => {
    await isolated.db.delete(loginTokens);
    const row = (
      tokenChar: string,
      emailChar: string,
      created: Date,
      expires: Date,
      used?: Date,
    ) => ({
      tokenHash: hex(tokenChar),
      emailHash: hex(emailChar),
      createdAt: created,
      expiresAt: expires,
      ...(used === undefined ? {} : { usedAt: used }),
    });
    await isolated.db
      .insert(loginTokens)
      .values([
        row('a', '1', at(-30), at(-29)),
        row('b', '1', at(-30), at(5), at(-29)),
        row('c', '1', at(-30), at(5)),
        row('d', '1', at(-2), at(-1)),
      ]);
    expect(await sweep().deleteLoginTokensBefore(at(-24))).toBe(2);
    const left = await isolated.db.select({ token: loginTokens.tokenHash }).from(loginTokens);
    expect(left.map((token) => token.token).sort()).toEqual([hex('c'), hex('d')]);
  });

  it('deletes admissions made before the cutoff and keeps the ones at it', async () => {
    await isolated.db.delete(demoRunAdmissions);
    const guest = await insertDemoWorkspace(isolated, { createdAt: T0, demoExpiresAt: null });
    await isolated.db.insert(demoRunAdmissions).values([
      { userId: guest.userId, clientKey: 'k', createdAt: new Date(T0.getTime() - 1) },
      { userId: guest.userId, clientKey: 'k', createdAt: T0 },
    ]);
    expect(await sweep().deleteAdmissionsBefore(T0)).toBe(1);
    expect(await isolated.db.select().from(demoRunAdmissions)).toHaveLength(1);
  });
});
