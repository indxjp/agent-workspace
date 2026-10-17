/**
 * `DatabaseRoot.resolveMembership` against a real PostgreSQL.
 *
 * ## Why this file exists
 *
 * This is the one query in the layer that runs *before* a {@link WorkspaceScope} exists, because
 * it is what decides which tenant a request acts as. Verification round 1 of W2-DB-02 moved it out
 * of `apps/web/instrumentation.ts` and into `root.ts`; verification round 2 found that it had no
 * test in either home. An authorisation decision with no executable check is the shape ADR-0015
 * is about, and "it is three obvious `findFirst` calls" is exactly what the reviewer of the next
 * change will also think.
 *
 * ## What it asserts, and why in this order
 *
 * `resolveMembership` answers with two ids **only** when three rows exist and agree: a workspace
 * with that slug, a user with that email, and a membership joining the two. The four negative
 * cases below are the four ways that can fail, and each is asserted separately so that one of them
 * holding cannot stand in for another. The cross-tenant case is the one spec §25 is about: a
 * person who is a member of one workspace must not resolve an identity in a workspace they are not
 * a member of, even though both of that call's first two lookups succeed.
 *
 * The revocation case is the reason the function is three queries rather than one. A session
 * carries a workspace slug and a subject; deriving the workspace id from the slug alone would make
 * `delete from memberships …` take effect only when the token expired. The assertion here is the
 * before/after pair around that delete.
 *
 * ## It needs a database, and it says so when it does not have one
 *
 * `TEST_DATABASE_URL` names a PostgreSQL account permitted to `CREATE DATABASE`; the suite creates
 * its own database, migrates it, and drops it. Without the variable the block below is skipped and
 * a warning says what did not run, so a green local result is not mistaken for a checked one. CI
 * sets the variable, and its "No test in the run was skipped" step is what makes that binding.
 */
import crypto from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { modelConnections } from '../schema/model-connections.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { openDatabaseRoot, type DatabaseRoot } from './root.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[repositories/root.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the authorisation ' +
      'query that decides which tenant a request acts as was NOT exercised. A green result ' +
      'without it says nothing about DatabaseRoot.resolveMembership.',
  );
}

describe.skipIf(!hasDatabase)('DatabaseRoot.resolveMembership', () => {
  let isolated: IsolatedTestDatabase;
  let root: DatabaseRoot;

  /** Two tenants, one member each, plus a person who belongs to neither. */
  const acme = { id: crypto.randomUUID(), slug: 'acme', name: 'Acme' };
  const globex = { id: crypto.randomUUID(), slug: 'globex', name: 'Globex' };
  const alice = { id: crypto.randomUUID(), email: 'alice@acme.test', name: 'Alice' };
  const bob = { id: crypto.randomUUID(), email: 'bob@globex.test', name: 'Bob' };
  const nomad = { id: crypto.randomUUID(), email: 'nomad@example.test', name: 'Nomad' };
  const aliceMembershipId = crypto.randomUUID();
  const bobMembershipId = crypto.randomUUID();
  const alicePrincipalId = crypto.randomUUID();
  const bobPrincipalId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w2db02_root');
    await isolated.db.insert(workspaces).values([acme, globex]);
    await isolated.db.insert(users).values([alice, bob, nomad]);
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values([
        { id: aliceMembershipId, workspaceId: acme.id, userId: alice.id, role: 'owner' },
        { id: bobMembershipId, workspaceId: globex.id, userId: bob.id, role: 'owner' },
      ]);
      await tx.insert(workspacePrincipals).values([
        {
          id: alicePrincipalId,
          workspaceId: acme.id,
          kind: 'membership',
          membershipId: aliceMembershipId,
        },
        {
          id: bobPrincipalId,
          workspaceId: globex.id,
          kind: 'membership',
          membershipId: bobMembershipId,
        },
      ]);
    });
    // Through the public entry point, with its own pool, exactly as a composition root opens it.
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
  }, 180_000);

  afterAll(async () => {
    await root.close();
    await isolated.close();
  });

  it('answers with both ids when a workspace, a user and a membership all agree', async () => {
    await expect(root.resolveMembership(alice.email, acme.slug)).resolves.toEqual({
      principalId: alicePrincipalId,
      userId: alice.id,
      userLabel: alice.name,
      workspaceId: acme.id,
      role: 'owner',
    });
  });

  it('answers null when no workspace carries that slug', async () => {
    await expect(root.resolveMembership(alice.email, 'no-such-workspace')).resolves.toBeNull();
  });

  it('answers null when no user carries that email', async () => {
    await expect(root.resolveMembership('nobody@example.test', acme.slug)).resolves.toBeNull();
  });

  it('answers null for a real user in a real workspace they are not a member of', async () => {
    // Spec §25. Both of the first two lookups succeed here; only the third refuses. A version of
    // this function that derived the workspace id from the slug and trusted the session's subject
    // would answer with Acme's workspace id and Bob's user id.
    await expect(root.resolveMembership(bob.email, acme.slug)).resolves.toBeNull();
    await expect(root.resolveMembership(alice.email, globex.slug)).resolves.toBeNull();
  });

  it('answers null for a user who is a member of no workspace at all', async () => {
    await expect(root.resolveMembership(nomad.email, acme.slug)).resolves.toBeNull();
  });

  it('stops answering the moment the membership row is deleted', async () => {
    const carol = { id: crypto.randomUUID(), email: 'carol@acme.test', name: 'Carol' };
    const carolMembershipId = crypto.randomUUID();
    const carolPrincipalId = crypto.randomUUID();
    await isolated.db.insert(users).values(carol);
    await isolated.db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: carolMembershipId, workspaceId: acme.id, userId: carol.id, role: 'viewer' });
      await tx.insert(workspacePrincipals).values({
        id: carolPrincipalId,
        workspaceId: acme.id,
        kind: 'membership',
        membershipId: carolMembershipId,
      });
    });

    await expect(root.resolveMembership(carol.email, acme.slug)).resolves.toEqual({
      principalId: carolPrincipalId,
      userId: carol.id,
      userLabel: carol.name,
      workspaceId: acme.id,
      role: 'viewer',
    });

    await isolated.db
      .delete(memberships)
      .where(and(eq(memberships.workspaceId, acme.id), eq(memberships.userId, carol.id)));

    // The workspace row and the user row both still exist; the identity does not.
    await expect(root.resolveMembership(carol.email, acme.slug)).resolves.toBeNull();
  });

  it('is case-sensitive about the email it is given, so a lookup is a lookup', async () => {
    // Not a security property and not asserted as one: it records that the normalisation lives at
    // the edge — `seed.ts` lower-cases `BOOTSTRAP_ADMIN` before it writes — rather than in this
    // query. A caller that stops normalising will see this test, not a silent widening.
    await expect(root.resolveMembership(alice.email.toUpperCase(), acme.slug)).resolves.toBeNull();
  });
});

// issue #129: the workspace-wide model default — the last rung of the resolution ladder.
describe.skipIf(!hasDatabase)('DatabaseRoot workspace model default', () => {
  let isolated: IsolatedTestDatabase;
  let root: DatabaseRoot;
  const workspaceId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_w9model129_workspace_default');
    await isolated.db
      .insert(workspaces)
      .values({ id: workspaceId, slug: 'w9-model-129', name: 'Model default workspace' });
    await isolated.db.insert(modelConnections).values({
      id: connectionId,
      workspaceId,
      name: 'Claude',
      provider: 'anthropic',
      config: {},
    });
    await isolated.db.insert(users).values({
      id: ownerUserId,
      email: 'w9-model-129@example.test',
      name: 'Model default owner',
    });
    await isolated.db.insert(memberships).values({
      id: ownerMembershipId,
      workspaceId,
      userId: ownerUserId,
      role: 'owner',
    });
    // A membership gets its principal from the database itself; read that one back.
    const [principal] = await isolated.db
      .select({ id: workspacePrincipals.id })
      .from(workspacePrincipals)
      .where(eq(workspacePrincipals.membershipId, ownerMembershipId));
    if (principal === undefined) throw new Error('fixture membership principal');
    ownerPrincipalId = principal.id;
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
  }, 180_000);

  const ownerUserId = crypto.randomUUID();
  const ownerMembershipId = crypto.randomUUID();
  let ownerPrincipalId = '';

  /** One agent in the fixture workspace, created through the scoped repository. */
  async function insertAgent(name: string): Promise<string> {
    const scope = await root.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('fixture workspace scope');
    const created = await root.agents.forScope(scope).create({
      name,
      instructions: '',
      modelConnectionId: null,
      model: null,
      runtimeProfileId: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      ownerPrincipalId,
      createdBy: ownerUserId,
    });
    if (created.kind !== 'created') throw new Error(`fixture agent: ${created.kind}`);
    return created.agent.id;
  }

  afterAll(async () => {
    await root.close();
    await isolated.close();
  });

  it('answers null before any default is set', async () => {
    await expect(root.getWorkspaceModelDefault(workspaceId)).resolves.toBeNull();
  });

  it('sets and reads the default back as one pair', async () => {
    await expect(
      root.setWorkspaceModelDefault(workspaceId, {
        connectionId,
        model: 'claude-sonnet-4-5',
      }),
    ).resolves.toBe(true);
    await expect(root.getWorkspaceModelDefault(workspaceId)).resolves.toEqual({
      connectionId,
      model: 'claude-sonnet-4-5',
    });
  });

  it('clears both columns together when set to null', async () => {
    await expect(root.setWorkspaceModelDefault(workspaceId, null)).resolves.toBe(true);
    await expect(root.getWorkspaceModelDefault(workspaceId)).resolves.toBeNull();
  });

  it('answers false for a workspace id that does not exist', async () => {
    await expect(
      root.setWorkspaceModelDefault(crypto.randomUUID(), {
        connectionId,
        model: 'claude-sonnet-4-5',
      }),
    ).resolves.toBe(false);
  });

  // PR #403 review: first-run setup marks the agent it configured, for the composer.
  it('marks and reads back the setup agent, the latest mark winning', async () => {
    await expect(root.getWorkspaceSetupAgentId(workspaceId)).resolves.toBeNull();
    const first = await insertAgent('Setup agent');
    await expect(root.setWorkspaceSetupAgentId(workspaceId, first)).resolves.toBe(true);
    await expect(root.getWorkspaceSetupAgentId(workspaceId)).resolves.toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await insertAgent('Second setup agent');
    await expect(root.setWorkspaceSetupAgentId(workspaceId, second)).resolves.toBe(true);
    await expect(root.getWorkspaceSetupAgentId(workspaceId)).resolves.toBe(second);
  });

  it("never marks another workspace's agent, or an id that is no agent (§25)", async () => {
    const otherWorkspace = crypto.randomUUID();
    await isolated.db
      .insert(workspaces)
      .values({ id: otherWorkspace, slug: 'w9-model-129-other', name: 'Other workspace' });
    const agentId = await insertAgent('Elsewhere');
    await expect(root.setWorkspaceSetupAgentId(otherWorkspace, agentId)).resolves.toBe(false);
    await expect(root.getWorkspaceSetupAgentId(otherWorkspace)).resolves.toBeNull();
    await expect(root.setWorkspaceSetupAgentId(workspaceId, crypto.randomUUID())).resolves.toBe(
      false,
    );
  });

  // Issue #415: a rolled-back setup takes its mark back.
  it('clears one mark, after which the previous mark is the setup agent again', async () => {
    const earlier = await insertAgent('Earlier setup agent');
    await root.setWorkspaceSetupAgentId(workspaceId, earlier);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const later = await insertAgent('Later setup agent');
    await root.setWorkspaceSetupAgentId(workspaceId, later);
    await expect(root.clearWorkspaceSetupAgentId(workspaceId, later)).resolves.toBe(true);
    await expect(root.getWorkspaceSetupAgentId(workspaceId)).resolves.toBe(earlier);
    await expect(root.clearWorkspaceSetupAgentId(crypto.randomUUID(), earlier)).resolves.toBe(
      false,
    );
  });

  // C21 (plan §4, S2-07a): marking or clearing the setup agent is not an edit of it.
  it("leaves the agent's updated_at alone when it is marked and cleared as the setup agent", async () => {
    const backdated = new Date('2020-01-01T00:00:00Z');
    const agentId = await insertAgent('Untouched setup agent');
    await isolated.db.update(agents).set({ updatedAt: backdated }).where(eq(agents.id, agentId));
    const readAgent = async () => {
      const [row] = await isolated.db
        .select({ updatedAt: agents.updatedAt, setupConfiguredAt: agents.setupConfiguredAt })
        .from(agents)
        .where(eq(agents.id, agentId));
      if (row === undefined) throw new Error('fixture agent is missing');
      return row;
    };
    // The previous test's marks were made at most a few milliseconds ago; this one must be later.
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(root.setWorkspaceSetupAgentId(workspaceId, agentId)).resolves.toBe(true);
    await expect(root.getWorkspaceSetupAgentId(workspaceId)).resolves.toBe(agentId);
    const marked = await readAgent();
    expect(marked.setupConfiguredAt).not.toBeNull();
    expect(marked.updatedAt).toEqual(backdated);

    await expect(root.clearWorkspaceSetupAgentId(workspaceId, agentId)).resolves.toBe(true);
    const cleared = await readAgent();
    expect(cleared.setupConfiguredAt).toBeNull();
    expect(cleared.updatedAt).toEqual(backdated);
  });

  // Issue #415: two setups of one workspace never overlap; other workspaces are not held up.
  it('serialises work under one workspace setup lock and releases it however work ends', async () => {
    const events: string[] = [];
    const held = (label: string, ms: number) => async () => {
      events.push(`${label}:start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      events.push(`${label}:end`);
      return label;
    };
    await expect(
      root.withWorkspaceSetupLock(workspaceId, 1_000, () => Promise.reject(new Error('refused'))),
    ).rejects.toThrow('refused');
    const results = await Promise.all([
      root.withWorkspaceSetupLock(workspaceId, 5_000, held('a', 40)),
      root.withWorkspaceSetupLock(workspaceId, 5_000, held('b', 5)),
      root.withWorkspaceSetupLock(crypto.randomUUID(), 0, () => Promise.resolve('other')),
    ]);
    expect(results).toEqual([
      { acquired: true, value: 'a' },
      { acquired: true, value: 'b' },
      { acquired: true, value: 'other' },
    ]);
    // Whichever took the lock first finished before the other started.
    const label = (event: string | undefined) => event?.split(':')[0];
    expect(label(events[0])).toBe(label(events[1]));
    expect(events.map((event) => event.split(':')[1])).toEqual(['start', 'end', 'start', 'end']);
  });

  it('gives up waiting for a held setup lock once its wait has passed', async () => {
    let release = (): void => undefined;
    const holding = root.withWorkspaceSetupLock(
      workspaceId,
      1_000,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    let ran = false;
    const waited = await root.withWorkspaceSetupLock(workspaceId, 200, () => {
      ran = true;
      return Promise.resolve();
    });
    expect(waited).toEqual({ acquired: false });
    expect(ran).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    release();
    await expect(holding).resolves.toEqual({ acquired: true, value: undefined });
    // Released, it is free again at once.
    await expect(
      root.withWorkspaceSetupLock(workspaceId, 0, () => Promise.resolve('free')),
    ).resolves.toEqual({ acquired: true, value: 'free' });
  });

  it('forgets the setup agent when that agent is deleted', async () => {
    const scope = await root.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('fixture workspace scope');
    for (;;) {
      const marked = await root.getWorkspaceSetupAgentId(workspaceId);
      if (marked === null) break;
      await expect(root.agents.forScope(scope).delete(marked)).resolves.toEqual({
        kind: 'deleted',
      });
    }
    await expect(root.getWorkspaceSetupAgentId(workspaceId)).resolves.toBeNull();
  });
});
