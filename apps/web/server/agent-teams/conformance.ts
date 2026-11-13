/**
 * The contract every {@link AgentTeamsRuntime} meets (ADR-0104 acceptance, issue #1516), run by
 * `conformance.test.ts` against the in-memory runtime the route tests use and the PostgreSQL one
 * the composition installs, so the two cannot drift (F-13). Test support; no route imports it.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import type { AgentTeamsRuntime } from './runtime';

interface Pin {
  readonly agentId: string;
  readonly agentVersionId: string;
}

export interface AgentTeamStoreFixture {
  readonly runtime: AgentTeamsRuntime;
  readonly workspaceId: string;
  readonly otherWorkspaceId: string;
  /** A principal of `workspaceId` that may own teams and act in audit rows. */
  readonly ownerPrincipalId: string;
  readonly lead: Pin;
  /** A version of an agent of `workspaceId` whose name is `memberName`, a valid member name. */
  readonly member: Pin;
  readonly memberName: string;
  /** A version of an agent of `otherWorkspaceId`. */
  readonly foreign: Pin;
}

export function describeAgentTeamStoreConformance(
  name: string,
  setup: () => Promise<AgentTeamStoreFixture>,
): void {
  describe(`AgentTeamsRuntime conformance: ${name}`, () => {
    let fixture: AgentTeamStoreFixture;
    beforeAll(async () => {
      fixture = await setup();
    }, 180_000);

    const repository = () => fixture.runtime.repository(fixture.workspaceId);
    const create = async (teamName: string, withVersion = true) => {
      const outcome = await (
        await repository()
      ).create({
        name: teamName,
        ownerPrincipalId: fixture.ownerPrincipalId,
        createdBy: null,
        ...(withVersion ? { version: { lead: fixture.lead, members: [fixture.member] } } : {}),
      });
      if (outcome.kind !== 'created') throw new Error(`create answered ${outcome.kind}`);
      return outcome.team;
    };

    it('creates a team with version 1, naming the member after its agent', async () => {
      const team = await create('Conformance one');
      expect(team.latestVersion).toMatchObject({
        number: 1,
        mode: 'handoff',
        lead: fixture.lead,
        members: [{ name: fixture.memberName, ...fixture.member }],
      });
      expect(await (await repository()).get(team.id)).toMatchObject({
        id: team.id,
        name: team.name,
      });
    });

    it('refuses a live name twice, and frees it on delete', async () => {
      const team = await create('Conformance two', false);
      const again = await (
        await repository()
      ).create({ name: team.name, ownerPrincipalId: fixture.ownerPrincipalId, createdBy: null });
      expect(again.kind).toBe('name-taken');
      expect(await (await repository()).softDelete(team.id)).toBe(true);
      expect(await (await repository()).get(team.id)).toBeNull();
      expect(await (await repository()).softDelete(team.id)).toBe(false);
      await create('Conformance two', false);
    });

    it("refuses another workspace's agent, the lead listed, and keeps the team out of other workspaces", async () => {
      const team = await create('Conformance three', false);
      const teams = await repository();
      expect(
        await teams.createVersion(team.id, {
          lead: fixture.lead,
          members: [fixture.foreign],
          createdBy: null,
        }),
      ).toMatchObject({ kind: 'member-invalid', problem: 'unknown-version' });
      expect(
        await teams.createVersion(team.id, {
          lead: fixture.lead,
          members: [fixture.member, fixture.lead],
          createdBy: null,
        }),
      ).toMatchObject({ kind: 'member-invalid', problem: 'lead-is-member' });
      const other = await fixture.runtime.repository(fixture.otherWorkspaceId);
      expect(await other.get(team.id)).toBeNull();
      expect(
        await other.createVersion(team.id, {
          lead: fixture.lead,
          members: [fixture.member],
          createdBy: null,
        }),
      ).toEqual({ kind: 'not-found' });
      expect(await other.listVersions(team.id)).toBeNull();
    });

    it('numbers versions in turn and lists them newest first, one page at a time', async () => {
      const team = await create('Conformance four');
      const teams = await repository();
      const second = await teams.createVersion(team.id, {
        lead: fixture.lead,
        members: [{ ...fixture.member, name: 'renamed' }],
        createdBy: null,
      });
      expect(second).toMatchObject({ kind: 'created', version: { number: 2 } });
      const first = await teams.listVersions(team.id, { limit: 1 });
      expect(first?.items.map((version) => version.number)).toEqual([2]);
      expect(first?.nextCursor).toBe(2);
      const rest = await teams.listVersions(team.id, {
        limit: 1,
        cursor: first?.nextCursor ?? null,
      });
      expect(rest).toMatchObject({ items: [{ number: 1 }], nextCursor: null });
      expect((await teams.get(team.id))?.latestVersion?.number).toBe(2);
    });

    it('reads a version by id, after its team is deleted, and never from another workspace', async () => {
      const team = await create('Conformance eight');
      const version = team.latestVersion;
      if (version === null) throw new Error('the team has no version');
      const teams = await repository();
      expect(await teams.getVersion(version.id)).toMatchObject({ id: version.id, number: 1 });
      expect(await teams.softDelete(team.id)).toBe(true);
      expect((await teams.getVersion(version.id))?.members).toEqual(version.members);
      const other = await fixture.runtime.repository(fixture.otherWorkspaceId);
      expect(await other.getVersion(version.id)).toBeNull();
      expect(await teams.getVersion('not-a-uuid')).toBeNull();
    });

    it('lists live teams newest first, keyset paged', async () => {
      const older = await create('Conformance five', false);
      const newer = await create('Conformance six', false);
      const teams = await repository();
      const page = await teams.list({ limit: 1 });
      expect(page.items.map((team) => team.id)).toEqual([newer.id]);
      const next = await teams.list({ limit: 1, cursor: page.nextCursor });
      expect(next.items.map((team) => team.id)).toEqual([older.id]);
      const other = await fixture.runtime.repository(fixture.otherWorkspaceId);
      expect((await other.list()).items.map((team) => team.id)).not.toContain(newer.id);
    });

    it('records an audit row for a team write', async () => {
      const team = await create('Conformance seven', false);
      await expect(
        fixture.runtime.recordAudit({
          workspaceId: fixture.workspaceId,
          actorPrincipalId: fixture.ownerPrincipalId,
          actorUserId: null,
          actorLabel: 'Conformance',
          action: 'agent-changed',
          subjectId: team.id,
          subjectLabel: `agent team ${team.name}: created`,
        }),
      ).resolves.toBeUndefined();
    });
  });
}
