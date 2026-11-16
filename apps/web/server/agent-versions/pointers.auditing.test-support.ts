import { expect, it, vi } from 'vitest';
import { OWNER } from './pipeline.test-support';
import { setAgentPointer } from './pointers';
import { ACTOR, agentWithVersions, harness, point } from './pointers.test-support';
import type { WorkspaceAgentVersionStore } from './store';

export function registerPointerAuditingTests() {
  it("answers 409 agent_name_conflict when the version's agent name is another agent's", async () => {
    const h = await harness();
    await h.createAgent('Billing');
    const agent = await h.createAgent('Support triage');
    // A version may rename its agent; this one takes a name the workspace already uses.
    await h.save(agent, { name: 'Billing' });
    const result = await point(agent, 'local', 1, { store: h.store });
    expect(result).toEqual({
      status: 409,
      body: {
        error: {
          code: 'agent_name_conflict',
          message: 'This workspace already has an agent named "Billing".',
        },
      },
    });
    expect((await h.current(agent.id)).name).toBe('Support triage');
    expect(h.provider.audits()).toEqual([]);
  });

  it('throws on a second reference-gone rather than chasing the race', async () => {
    const h = await harness();
    const agent = await agentWithVersions(h, {});
    const store = {
      ...h.store,
      applyAndPoint: vi
        .fn<WorkspaceAgentVersionStore['applyAndPoint']>()
        .mockResolvedValue({ kind: 'reference-gone', referenceKind: 'skill' }),
    };
    await expect(
      setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
        store,
      }),
    ).rejects.toThrow(/deleted twice/u);
    expect(h.provider.audits()).toEqual([]);
  });

  it('hands the store the audit row and propagates a refused in-transaction audit write (#478)', async () => {
    const h = await harness();
    const agent = await agentWithVersions(h, {});
    // The repository rejects when `audit_events` refuses the row, and its transaction rolls back.
    const applyAndPoint = vi
      .fn<WorkspaceAgentVersionStore['applyAndPoint']>()
      .mockRejectedValue(new Error('audit insert failed'));
    await expect(
      setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
        store: { ...h.store, applyAndPoint },
      }),
    ).rejects.toThrow(/audit insert failed/u);
    expect(applyAndPoint).toHaveBeenCalledWith(
      agent.id,
      expect.objectContaining({
        audit: {
          subjectLabel: 'Support triage: local -> version 1',
          actorPrincipalId: OWNER,
          actorUserId: null,
          actorLabel: 'builder key',
        },
      }),
    );
    expect(h.provider.pointerCount()).toBe(0);
    expect(h.provider.audits()).toEqual([]);
    expect((await h.current(agent.id)).instructions).toBe('Before any version.');
  });
}
