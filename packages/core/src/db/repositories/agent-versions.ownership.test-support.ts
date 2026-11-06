import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { bodyWith, type createAgentVersionFixture } from './agent-versions.fixture.test-support.js';
export function registerOwnershipCases(fixture: ReturnType<typeof createAgentVersionFixture>) {
  it('answers unknown-creator-agent, writing nothing, when the lineage names no agent or is half set (#1851)', async () => {
    const creatorId = await fixture.seedAgent('lineage-creator');
    const lineage = { agentId: creatorId, version: 1, runId: 'run-1' };
    const cases = [
      { label: 'no-agent', createdByAgent: { ...lineage, agentId: crypto.randomUUID() } },
      // The run id missing while the version is set: only agents_created_by_agent_lineage_check refuses it.
      {
        label: 'half-set',
        createdByAgent: { ...lineage, runId: undefined } as unknown as typeof lineage,
      },
    ];
    for (const { label, createdByAgent } of cases) {
      await expect(
        fixture.repoA.createAgentWithFirstVersion({
          agent: {
            ...fixture.materialise({ name: `lineage-${label}` }),
            ownerPrincipalId: fixture.principalA,
            createdBy: fixture.userA,
            createdByAgent,
          },
          version: {
            summary: `lineage-${label}`,
            via: 'builder',
            body: bodyWith(`lineage-${label}`),
            createdByPrincipalId: fixture.principalA,
          },
          environment: 'local',
        }),
      ).resolves.toEqual({ kind: 'unknown-creator-agent' });
      const left = await fixture.isolated.db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(eq(agents.workspaceId, fixture.workspaceA), eq(agents.name, `lineage-${label}`)),
        );
      expect(left).toEqual([]);
    }
  });

  it('answers unknown-principal, writing nothing, when the owner or the author is not of this workspace', async () => {
    const stranger = crypto.randomUUID();
    const cases = [
      { label: 'owner-b', owner: fixture.principalB, author: fixture.principalA },
      { label: 'author-b', owner: fixture.principalA, author: fixture.principalB },
      { label: 'author-unknown', owner: fixture.principalA, author: stranger },
    ];
    for (const { label, owner, author } of cases) {
      await expect(
        fixture.repoA.createAgentWithFirstVersion({
          agent: {
            ...fixture.materialise({ name: `stranger-${label}` }),
            ownerPrincipalId: owner,
            createdBy: fixture.userA,
          },
          version: {
            summary: `stranger-${label}`,
            via: 'api',
            body: bodyWith(`stranger-${label}`),
            createdByPrincipalId: author,
          },
          environment: 'local',
        }),
      ).resolves.toEqual({ kind: 'unknown-principal' });
      const left = await fixture.isolated.db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(eq(agents.workspaceId, fixture.workspaceA), eq(agents.name, `stranger-${label}`)),
        );
      expect(left).toEqual([]);
    }
  });

  it('keeps an author’s versions when their membership is removed, refusing the removal (RF-202)', async () => {
    // A Builder who owns no agent writes a version of an agent someone else owns. Removing that
    // member must not erase or rewrite the immutable history: the author FK refuses the removal,
    // as `agents_owner_principal_workspace_fk` and the other owner FKs do until RF-202 defines
    // offboarding and reassignment.
    const builderUser = crypto.randomUUID();
    const builderMembership = crypto.randomUUID();
    const builderPrincipal = crypto.randomUUID();
    await fixture.isolated.db
      .insert(users)
      .values({ id: builderUser, email: `${builderUser}@example.test`, name: 'Builder A' });
    await fixture.isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({
        id: builderMembership,
        workspaceId: fixture.workspaceA,
        userId: builderUser,
        role: 'builder',
      });
      await tx.insert(workspacePrincipals).values({
        id: builderPrincipal,
        workspaceId: fixture.workspaceA,
        kind: 'membership',
        membershipId: builderMembership,
      });
    });
    const agentId = await fixture.seedAgent('authored-by-builder');
    const authored = await fixture.repoA.create(agentId, {
      summary: 'builder change',
      via: 'ui',
      body: bodyWith(),
      createdByPrincipalId: builderPrincipal,
    });
    if (authored.kind !== 'created') throw new Error(`expected created, got ${authored.kind}`);

    const violations = await fixture.violationsOf(
      fixture.isolated.db.delete(memberships).where(eq(memberships.id, builderMembership)),
    );
    expect(violations.map((violation) => [violation.code, violation.constraint])).toContainEqual([
      '23503',
      'agent_versions_created_by_principal_workspace_fk',
    ]);
    await expect(fixture.repoA.find(agentId, 1)).resolves.toMatchObject({
      id: authored.version.id,
      createdByPrincipalId: builderPrincipal,
    });
  });
}
