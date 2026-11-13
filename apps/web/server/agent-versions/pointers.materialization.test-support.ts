import { expect, it } from 'vitest';
import { SetAgentPointerResponseSchema } from '@indx-workspace/contracts/agent-versions';
import { OWNER, WORKSPACE } from './pipeline.test-support';
import { agentWithVersions, harness, point } from './pointers.test-support';

export function registerPointerMaterializationTests() {
  it('materialises the version, points local at it and records one agent-changed row', async () => {
    const h = await harness();
    const agent = await agentWithVersions(
      h,
      { instructions: 'Version one.', resources: { connectors: ['tickets'] } },
      { instructions: 'Version two.' },
    );

    const result = await point(agent, 'local', 1, { store: h.store });

    expect(result.status).toBe(200);
    const body = SetAgentPointerResponseSchema.parse(result.body);
    expect(body.agent.instructions).toBe('Version one.');
    expect(body.pointer).toMatchObject({ environment: 'local', number: 1 });
    expect((await h.current(agent.id)).instructions).toBe('Version one.');
    expect(h.provider.assignmentsOf(agent.id)).toEqual({
      skillIds: [],
      connectorIds: ['c1'],
      files: [],
      storageGrants: [],
    });
    expect((await h.store.list(agent.id))?.pointers.map((pointer) => pointer.number)).toEqual([1]);
    expect(h.provider.audits()).toEqual([
      {
        workspaceId: WORKSPACE,
        action: 'agent-changed',
        subjectId: agent.id,
        subjectLabel: 'Support triage: local -> version 1',
        actorPrincipalId: OWNER,
        actorUserId: null,
        actorLabel: 'builder key',
      },
    ]);
  });

  it('moves an existing pointer: pointing at version 2 replaces local -> 1', async () => {
    const h = await harness();
    const agent = await agentWithVersions(
      h,
      { instructions: 'Version one.' },
      { instructions: 'Version two.' },
    );
    const deps = { store: h.store };
    await point(agent, 'local', 1, deps);
    const moved = await point(await h.current(agent.id), 'local', 2, deps);
    expect(moved.status).toBe(200);
    expect(h.provider.pointerCount()).toBe(1);
    expect((await h.current(agent.id)).instructions).toBe('Version two.');
    expect(h.provider.audits()).toHaveLength(2);
  });

  it('points production without touching the row or the assignments, and audits it (#612)', async () => {
    const h = await harness();
    const agent = await agentWithVersions(
      h,
      { instructions: 'Version one.', resources: { connectors: ['tickets'] } },
      { instructions: 'Version two.' },
    );
    const deps = { store: h.store };
    await point(agent, 'local', 2, deps);
    const before = await h.current(agent.id);
    const assignments = h.provider.assignmentsOf(agent.id);

    const result = await point(before, 'production', 1, deps);

    expect(result.status).toBe(200);
    const body = SetAgentPointerResponseSchema.parse(result.body);
    expect(body.agent.instructions).toBe('Version two.');
    expect(body.pointer).toMatchObject({ environment: 'production', number: 1 });
    expect(await h.current(agent.id)).toEqual(before);
    expect(h.provider.assignmentsOf(agent.id)).toEqual(assignments);
    expect(
      (await h.store.list(agent.id))?.pointers.map((pointer) => [
        pointer.environment,
        pointer.number,
      ]),
    ).toEqual([
      ['local', 2],
      ['production', 1],
    ]);
    expect(h.provider.audits().at(-1)?.subjectLabel).toBe(
      'Support triage: production -> version 1',
    );
  });
}
