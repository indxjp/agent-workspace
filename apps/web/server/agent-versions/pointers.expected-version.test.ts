import { describe, expect, it } from 'vitest';

import { setAgentPointer } from './pointers';
import { ACTOR, agentWithVersions, harness, point } from './pointers.test-support';

describe('setAgentPointer: expectedVersion, the compare-and-set (#1847)', () => {
  /** An agent with versions 1..3 saved and `local` pointed at version 1. */
  async function atVersionOne() {
    const h = await harness();
    const agent = await agentWithVersions(
      h,
      { instructions: 'Version one.' },
      { instructions: 'Version two.' },
      { instructions: 'Version three.' },
    );
    const deps = { store: h.store };
    await point(agent, 'local', 1, deps);
    return { h, agent, deps };
  }

  it('answers 409 pointer_moved for a stale expectation and moves nothing', async () => {
    const { h, agent, deps } = await atVersionOne();
    const before = await h.current(agent.id);
    const listedBefore = await h.store.list(agent.id);
    const auditsBefore = h.provider.audits();

    const result = await setAgentPointer(
      { environment: 'local', version: 3, expectedVersion: 2 },
      before,
      ACTOR,
      deps,
    );

    expect(result).toEqual({
      status: 409,
      body: {
        error: {
          code: 'pointer_moved',
          message: 'The environment no longer points at the version the move expected.',
          details: ['environment:local', 'current:1'],
        },
      },
    });
    expect(await h.current(agent.id)).toEqual(before);
    expect(await h.store.list(agent.id)).toEqual(listedBefore);
    expect(h.provider.audits()).toEqual(auditsBefore);
  });

  it('names no current version when the environment points at none', async () => {
    const { agent, deps } = await atVersionOne();
    const result = await setAgentPointer(
      { environment: 'production', version: 1, expectedVersion: 1 },
      agent,
      ACTOR,
      deps,
    );
    expect(result).toMatchObject({
      status: 409,
      body: {
        error: { code: 'pointer_moved', details: ['environment:production', 'current:none'] },
      },
    });
  });

  it('moves when the expectation holds, including null for an unset pointer', async () => {
    const { h, agent, deps } = await atVersionOne();
    const moved = await setAgentPointer(
      { environment: 'local', version: 2, expectedVersion: 1 },
      agent,
      ACTOR,
      deps,
    );
    expect(moved.status).toBe(200);
    expect((await h.current(agent.id)).instructions).toBe('Version two.');

    const promoted = await setAgentPointer(
      { environment: 'production', version: 2, expectedVersion: null },
      await h.current(agent.id),
      ACTOR,
      deps,
    );
    expect(promoted.status).toBe(200);
    const again = await setAgentPointer(
      { environment: 'production', version: 3, expectedVersion: null },
      await h.current(agent.id),
      ACTOR,
      deps,
    );
    expect(again).toMatchObject({
      status: 409,
      body: { error: { code: 'pointer_moved', details: ['environment:production', 'current:2'] } },
    });
  });

  it('moves unconditionally when expectedVersion is absent', async () => {
    const { h, agent, deps } = await atVersionOne();
    const moved = await point(agent, 'local', 3, deps);
    expect(moved.status).toBe(200);
    expect((await h.current(agent.id)).instructions).toBe('Version three.');
    expect(h.provider.pointerCount()).toBe(1);
  });

  it('refuses an expectedVersion that is not a version number as 400 invalid_agent_version', async () => {
    const { agent, deps } = await atVersionOne();
    const result = await setAgentPointer(
      { environment: 'local', version: 2, expectedVersion: 0 },
      agent,
      ACTOR,
      deps,
    );
    expect(result).toMatchObject({
      status: 400,
      body: { error: { code: 'invalid_agent_version' } },
    });
  });

  it('leaves the version a refused move was about to point at listed, with no pointer on it', async () => {
    const { h, agent, deps } = await atVersionOne();
    await h.save(agent, { instructions: 'Version four.' });

    const refused = await setAgentPointer(
      { environment: 'local', version: 4, expectedVersion: 3 },
      agent,
      ACTOR,
      deps,
    );

    expect(refused.status).toBe(409);
    const listing = await h.store.list(agent.id);
    expect(listing?.versions.map((version) => version.number)).toEqual([1, 2, 3, 4]);
    expect(listing?.pointers.map((pointer) => pointer.number)).toEqual([1]);
  });
});
