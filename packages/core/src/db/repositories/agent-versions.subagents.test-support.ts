import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents } from '../schema/agents.js';
import {
  READ_ONLY,
  bodyWith,
  type createAgentVersionFixture,
} from './agent-versions.fixture.test-support.js';
export function registerSubagentsCases(fixture: ReturnType<typeof createAgentVersionFixture>) {
  const {
    workspaceA,
    workspaceB,
    userA,
    userB,
    principalA,
    principalB,
    seedAgent,
    version,
    materialise,
    auditBy,
    snapshot,
  } = fixture;

  it('finds agents by name with the subagent flag of the materialised body (agentsByName)', async () => {
    const withSubagents = await seedAgent('by-name-nested');
    await version(withSubagents, {
      ...(bodyWith() as object),
      subagents: [{ name: 'by-name-plain' }],
    });
    const plain = await seedAgent('by-name-plain');
    await version(plain, { ...(bodyWith() as object), description: 'Plain.' });
    const unmaterialised = await seedAgent('by-name-unmaterialised');
    await version(unmaterialised, { ...(bodyWith() as object), subagents: [{ name: 'x' }] });
    const emptied = await seedAgent('by-name-empty-list');
    await version(emptied, { ...(bodyWith() as object), subagents: [] });
    await fixture.isolated.db.insert(agents).values({
      workspaceId: workspaceB,
      name: 'by-name-b-only',
      instructions: '',
      permissions: READ_ONLY,
      ownerPrincipalId: principalB,
      createdBy: userB,
    });
    for (const [id, name] of [
      [withSubagents, 'by-name-nested'],
      [plain, 'by-name-plain'],
      [emptied, 'by-name-empty-list'],
    ] as const) {
      const outcome = await fixture.repoA.applyAndPoint(id, {
        reason: 'set',
        audit: auditBy(),
        environment: 'local',
        number: 1,
        agent: materialise({ name }),
      });
      expect(outcome.kind).toBe('applied');
    }

    const found = await fixture.repoA.agentsByName([
      'by-name-nested',
      'by-name-plain',
      'by-name-unmaterialised',
      'by-name-empty-list',
      'by-name-b-only',
      'by-name-missing',
      'by-name-plain',
    ]);
    expect(Object.fromEntries(found)).toEqual({
      'by-name-nested': { id: withSubagents, hasSubagents: true, hasDescription: false },
      'by-name-plain': { id: plain, hasSubagents: false, hasDescription: true },
      'by-name-unmaterialised': { id: unmaterialised, hasSubagents: false, hasDescription: false },
      'by-name-empty-list': { id: emptied, hasSubagents: false, hasDescription: false },
    });
    await expect(fixture.repoA.agentsByName([])).resolves.toEqual(new Map());
  });

  describe('one level of subagents, both ways', () => {
    const namesSubagents = (...names: readonly string[]): unknown => ({
      ...(bodyWith() as object),
      subagents: names.map((name) => ({ name })),
    });

    /** Seed `names` as agents whose materialised version declares nothing. */
    async function seedPlain(...names: readonly string[]): Promise<Map<string, string>> {
      const ids = new Map<string, string>();
      for (const name of names) {
        const id = await seedAgent(name);
        const written = await version(id);
        const outcome = await fixture.repoA.applyAndPoint(id, {
          reason: 'set',
          audit: auditBy(),
          environment: 'local',
          number: written.number,
          agent: materialise({ name }),
        });
        expect(outcome.kind).toBe('applied');
        ids.set(name, id);
      }
      return ids;
    }

    const idOf = (ids: ReadonlyMap<string, string>, name: string): string => {
      const id = ids.get(name);
      if (id === undefined) throw new Error(`no seeded agent ${name}`);
      return id;
    };

    /** Write the next version of `name` naming `subagents`, and move `environment` to it. */
    async function declare(
      ids: ReadonlyMap<string, string>,
      name: string,
      subagents: readonly string[],
      environment: 'local' | 'production' = 'local',
    ) {
      const id = idOf(ids, name);
      const written = await version(id, namesSubagents(...subagents));
      return fixture.repoA.applyAndPoint(id, {
        reason: 'set',
        audit: auditBy(),
        environment,
        number: written.number,
        agent: materialise({ name }),
      });
    }

    /** Names of workspace A's agents that declare subagents and are also named by another agent. */
    async function nestedAgents(): Promise<readonly string[]> {
      const result = await fixture.isolated.db.execute(sql`
        select distinct a.name
        from agents a
        join agent_versions v on v.id = a.materialised_version_id
        where a.workspace_id = ${workspaceA}
          and jsonb_array_length(coalesce(v.body->'subagents', '[]'::jsonb)) > 0
          and exists (
            select 1
            from agents o
            join agent_versions ov on ov.id = o.materialised_version_id
            cross join lateral jsonb_array_elements(coalesce(ov.body->'subagents', '[]'::jsonb)) s(elem)
            where o.workspace_id = ${workspaceA} and o.id <> a.id and s.elem->>'name' = a.name
          )`);
      return result.rows.map((row) => String(row['name']));
    }

    it('refuses a parent naming an agent that has subagents', async () => {
      const ids = await seedPlain('nest-fwd-a', 'nest-fwd-b', 'nest-fwd-c');
      await expect(declare(ids, 'nest-fwd-b', ['nest-fwd-c'])).resolves.toMatchObject({
        kind: 'applied',
      });
      await expect(declare(ids, 'nest-fwd-a', ['nest-fwd-b'])).resolves.toEqual({
        kind: 'subagent-nesting',
        unusable: ['nest-fwd-b'],
        parents: [],
      });
    });

    it("refuses an agent that is already someone's subagent gaining subagents", async () => {
      const ids = await seedPlain('nest-rev-a', 'nest-rev-b', 'nest-rev-c');
      await expect(declare(ids, 'nest-rev-a', ['nest-rev-b'])).resolves.toMatchObject({
        kind: 'applied',
      });
      const before = await snapshot(idOf(ids, 'nest-rev-b'));
      await expect(declare(ids, 'nest-rev-b', ['nest-rev-c'])).resolves.toEqual({
        kind: 'subagent-nesting',
        unusable: [],
        parents: ['nest-rev-a'],
      });
      const after = await snapshot(idOf(ids, 'nest-rev-b'));
      expect(after.agent).toEqual(before.agent);
      expect(after.pointerRows).toEqual(before.pointerRows);
      expect(after.moveRows).toEqual(before.moveRows);
    });

    it('reports every missing subagent in body order, and an agent naming itself', async () => {
      const ids = await seedPlain('nest-missing-a', 'nest-missing-b');
      await expect(
        declare(ids, 'nest-missing-a', [
          'nest-missing-zz',
          'nest-missing-b',
          'nest-missing-aa',
          'nest-missing-a',
        ]),
      ).resolves.toEqual({
        kind: 'subagent-nesting',
        unusable: ['nest-missing-zz', 'nest-missing-aa', 'nest-missing-a'],
        parents: [],
      });
    });

    it('runs no check for a body without subagents or a non-local move', async () => {
      const ids = await seedPlain('nest-free-a', 'nest-free-b');
      await expect(declare(ids, 'nest-free-a', ['nest-free-b'])).resolves.toMatchObject({
        kind: 'applied',
      });
      // b has a parent now, but a body that declares nothing creates no edge.
      await expect(declare(ids, 'nest-free-b', [])).resolves.toMatchObject({ kind: 'applied' });
      // Only the materialised (local) bodies form the graph, so a production move is not checked.
      await expect(
        declare(ids, 'nest-free-b', ['nest-free-missing'], 'production'),
      ).resolves.toMatchObject({ kind: 'applied' });
    });

    it('refuses a new agent whose first version nests, either way', async () => {
      const ids = await seedPlain('nest-new-b', 'nest-new-c');
      await declare(ids, 'nest-new-b', ['nest-new-c']);
      const create = (name: string, subagents: readonly string[]) =>
        fixture.repoA.createAgentWithFirstVersion({
          agent: { ...materialise({ name }), ownerPrincipalId: principalA, createdBy: userA },
          version: {
            summary: 'first',
            via: 'api',
            body: namesSubagents(...subagents),
            createdByPrincipalId: principalA,
          },
          environment: 'local',
        });
      await expect(create('nest-new-a', ['nest-new-b'])).resolves.toEqual({
        kind: 'subagent-nesting',
        unusable: ['nest-new-b'],
        parents: [],
      });
      await expect(create('nest-new-c-parent', ['nest-new-c'])).resolves.toMatchObject({
        kind: 'created',
      });
      // A new agent named like an existing subagent is refused the same way an edit would be.
      await expect(create('nest-new-c', ['nest-new-x'])).resolves.toMatchObject({
        kind: 'subagent-nesting',
        unusable: ['nest-new-x'],
      });
    });

    it('lists the parents of a name, excluding the agent itself and other workspaces', async () => {
      const ids = await seedPlain('parents-a1', 'parents-a2', 'parents-child');
      await declare(ids, 'parents-a2', ['parents-child']);
      await declare(ids, 'parents-a1', ['parents-child']);
      await expect(fixture.repoA.subagentParents('parents-child', null)).resolves.toEqual([
        'parents-a1',
        'parents-a2',
      ]);
      await expect(
        fixture.repoA.subagentParents('parents-child', idOf(ids, 'parents-a1')),
      ).resolves.toEqual(['parents-a2']);
      await expect(fixture.repoB.subagentParents('parents-child', null)).resolves.toEqual([]);
    });

    it('cannot build A→B→C from two concurrent materialisations', async () => {
      for (let round = 0; round < 10; round += 1) {
        const [a, b, c] = [`race-${round}-a`, `race-${round}-b`, `race-${round}-c`] as const;
        const ids = await seedPlain(a, b, c);
        // Both versions are saved first: only the two materialising moves race.
        const [first, second] = await Promise.all([declare(ids, a, [b]), declare(ids, b, [c])]);
        expect([first.kind, second.kind].sort()).toEqual(['applied', 'subagent-nesting']);
      }
      await expect(nestedAgents()).resolves.toEqual([]);
      // Ten rounds of racing transactions against real PostgreSQL: seconds on a shared CI runner.
    }, 30_000);

    it('cannot build A→B→C from a created agent racing a materialisation', async () => {
      for (let round = 0; round < 10; round += 1) {
        const [a, b, c] = [`crace-${round}-a`, `crace-${round}-b`, `crace-${round}-c`] as const;
        const ids = await seedPlain(b, c);
        const [created, moved] = await Promise.all([
          fixture.repoA.createAgentWithFirstVersion({
            agent: { ...materialise({ name: a }), ownerPrincipalId: principalA, createdBy: userA },
            version: {
              summary: 'first',
              via: 'api',
              body: namesSubagents(b),
              createdByPrincipalId: principalA,
            },
            // Another environment's pointer lock: only the subagent lock can order the two.
            environment: 'production',
          }),
          declare(ids, b, [c]),
        ]);
        const succeeded = [created.kind === 'created', moved.kind === 'applied'];
        expect(succeeded.filter(Boolean)).toHaveLength(1);
      }
      await expect(nestedAgents()).resolves.toEqual([]);
      // Ten rounds of racing transactions against real PostgreSQL: seconds on a shared CI runner.
    }, 30_000);
  });
}
