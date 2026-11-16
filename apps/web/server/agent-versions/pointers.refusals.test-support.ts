import { expect, it } from 'vitest';
import { fixtureSurface, versionRequest } from './fixtures';
import { OWNER } from './pipeline.test-support';
import { setAgentPointer } from './pointers';
import { ACTOR, agentWithVersions, harness, point } from './pointers.test-support';

export function registerPointerRefusalsTests() {
  it('checks C9 per environment: a surface served in local may still be served in production', async () => {
    const h = await harness();
    const deps = { store: h.store };
    const first = await h.createAgent('Support triage');
    await h.save(first, { surfaces: [fixtureSurface('main')] });
    await point(first, 'production', 1, deps);
    const second = await h.createAgent('Billing');
    await h.save(second, { surfaces: [fixtureSurface('main', 'Billing')] });

    const local = await point(second, 'local', 1, deps);
    const production = await point(await h.current(second.id), 'production', 1, deps);

    expect(local.status).toBe(200);
    expect(production).toMatchObject({
      status: 409,
      body: { error: { code: 'surface_name_taken', details: ['surface:main'] } },
    });
  });

  it.each([
    ['an environment that does not exist', { environment: 'preview', version: 1 }],
    ['version 0', { environment: 'local', version: 0 }],
    ['an unknown key', { environment: 'local', version: 1, force: true }],
    ['a missing version', { environment: 'local' }],
  ])('answers 400 invalid_agent_version for %s', async (_name, body) => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    const result = await setAgentPointer(body, agent, ACTOR, {
      store: h.store,
    });
    expect(result).toMatchObject({
      status: 400,
      body: { error: { code: 'invalid_agent_version' } },
    });
    expect(h.provider.audits()).toEqual([]);
  });

  it('answers 404 agent_version_not_found naming the number, and writes nothing', async () => {
    const h = await harness();
    const agent = await agentWithVersions(h, {});
    const result = await point(agent, 'local', 9, { store: h.store });
    expect(result).toEqual({
      status: 404,
      body: {
        error: {
          code: 'agent_version_not_found',
          message: 'The agent has no version with that number.',
          details: ['version:9'],
        },
      },
    });
    expect(h.provider.pointerCount()).toBe(0);
    expect(h.provider.audits()).toEqual([]);
  });

  it('answers 409 surface_name_taken (C9) and leaves the row, assignments and pointer unchanged', async () => {
    const h = await harness();
    const first = await h.createAgent('Support triage');
    await h.save(first, { surfaces: [fixtureSurface('main')] });
    const deps = { store: h.store };
    expect((await point(first, 'local', 1, deps)).status).toBe(200);

    const second = await h.createAgent('Billing');
    await h.save(second, {
      instructions: 'Would serve main too.',
      surfaces: [fixtureSurface('main', 'Billing')],
    });
    const before = await h.current(second.id);
    const result = await point(before, 'local', 1, deps);

    expect(result).toMatchObject({
      status: 409,
      body: { error: { code: 'surface_name_taken', details: ['surface:main'] } },
    });
    expect(await h.current(second.id)).toEqual(before);
    expect(h.provider.assignmentsOf(second.id)).toBeUndefined();
    expect((await h.store.list(second.id))?.pointers).toEqual([]);
    expect(h.provider.audits()).toHaveLength(1);
  });

  it('answers 422 agent_subagent_unusable when the store finds the nesting a concurrent save built', async () => {
    const h = await harness();
    const agent = await agentWithVersions(h, {});
    // The pipeline saw no nesting; the store, inside the transaction that materialises, does.
    const store = {
      ...h.store,
      applyAndPoint: () =>
        Promise.resolve({
          kind: 'subagent-nesting' as const,
          unusable: ['ghost'],
          parents: ['boss'],
        }),
    };
    const result = await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
      store,
    });
    expect(result).toMatchObject({
      status: 422,
      body: {
        error: { code: 'agent_subagent_unusable', details: ['subagent:ghost', 'parent:boss'] },
      },
    });
    expect(h.provider.audits()).toEqual([]);
  });

  it("skips the name check on a production move: it never writes the row's name (#612)", async () => {
    const h = await harness();
    const deps = { store: h.store };
    const agent = await h.createAgent('Billing');
    await h.save(agent);
    await h.save(agent, { name: 'Billing v2' });
    await point(agent, 'local', 2, deps);
    // The name version 1 gives the agent is now another agent's.
    await h.createAgent('Billing');

    const result = await point(await h.current(agent.id), 'production', 1, deps);

    expect(result.status).toBe(200);
    expect((await h.current(agent.id)).name).toBe('Billing v2');
  });

  it('labels the audit row with the name the version gives the agent, not the old one', async () => {
    const h = await harness();
    const agent = await h.createAgent('Billing');
    await h.save(agent, { name: 'Billing v2' });
    const result = await point(agent, 'local', 1, { store: h.store });
    expect(result.status).toBe(200);
    expect((await h.current(agent.id)).name).toBe('Billing v2');
    expect(h.provider.audits().map((event) => event.subjectLabel)).toEqual([
      'Billing v2: local -> version 1',
    ]);
  });

  it('refuses 400 a stored version whose agent name is blank, and writes nothing', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    // Saved before the pipeline refused blank names: written to the store directly.
    const stored = await h.store.create(agent.id, {
      summary: 'Blank name',
      via: 'api',
      body: versionRequest({ name: '   ' }).body,
      createdByPrincipalId: OWNER,
    });
    expect(stored.kind).toBe('created');
    const result = await point(agent, 'local', 1, { store: h.store });
    expect(result).toEqual({
      status: 400,
      body: {
        error: {
          code: 'invalid_agent_version',
          message: 'The body is not a version request.',
          details: ['body.definition.agent.name: must not be blank'],
        },
      },
    });
    expect((await h.current(agent.id)).name).toBe('Support triage');
    expect(h.provider.pointerCount()).toBe(0);
    expect(h.provider.audits()).toEqual([]);
  });

  it('throws on a corrupt stored body: the pipeline is its only writer', async () => {
    const h = await harness();
    const agent = await h.createAgent('Support triage');
    await h.store.create(agent.id, {
      summary: 'Corrupt',
      via: 'api',
      body: { definition: 'no' },
      createdByPrincipalId: OWNER,
    });
    await expect(point(agent, 'local', 1, { store: h.store })).rejects.toThrow(/broken invariant/u);
  });
}
