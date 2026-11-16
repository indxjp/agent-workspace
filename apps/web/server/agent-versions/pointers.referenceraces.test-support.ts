import { expect, it, vi } from 'vitest';
import type { ApplyAndPointOutcome } from '@agent-workspace/core/db';
import { setAgentPointer } from './pointers';
import { ACTOR, agentWithVersions, harness } from './pointers.test-support';
import type { WorkspaceAgentVersionStore } from './store';

export function registerPointerReferenceRacesTests() {
  it('re-validates the stored version: an engine no longer registered refuses the move', async () => {
    const h = await harness();
    const agent = await agentWithVersions(h, {});
    const result = await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
      store: h.store,
      registered: ['pi'],
    });
    expect(result).toMatchObject({ status: 400, body: { error: { code: 'unsupported_engine' } } });
    expect(h.provider.pointerCount()).toBe(0);
  });

  it('re-resolves once on reference-gone and retries the write with the new ids', async () => {
    const h = await harness();
    const agent = await agentWithVersions(h, { resources: { connectors: ['tickets'] } });
    const gone: ApplyAndPointOutcome = { kind: 'reference-gone', referenceKind: 'connector' };
    const applyAndPoint = vi
      .fn<WorkspaceAgentVersionStore['applyAndPoint']>()
      .mockResolvedValueOnce(gone)
      .mockImplementation((id, input) => h.store.applyAndPoint(id, input));
    const resolveDefinition = vi.fn<WorkspaceAgentVersionStore['resolveDefinition']>((references) =>
      h.store.resolveDefinition(references),
    );
    const store = { ...h.store, applyAndPoint, resolveDefinition };
    const result = await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
      store,
    });
    expect(result.status).toBe(200);
    expect(applyAndPoint).toHaveBeenCalledTimes(2);
    // Once by the pipeline, once by the retry.
    expect(resolveDefinition).toHaveBeenCalledTimes(2);
    expect(h.provider.audits()).toHaveLength(1);
  });

  it('answers the resolution refusal when the reference is gone on re-resolve', async () => {
    const h = await harness();
    const agent = await agentWithVersions(h, { resources: { connectors: ['tickets'] } });
    const store = {
      ...h.store,
      applyAndPoint: vi
        .fn<WorkspaceAgentVersionStore['applyAndPoint']>()
        .mockResolvedValue({ kind: 'reference-gone', referenceKind: 'connector' }),
      resolveDefinition: vi
        .fn<WorkspaceAgentVersionStore['resolveDefinition']>()
        .mockImplementationOnce((references) => h.store.resolveDefinition(references))
        .mockResolvedValue({
          kind: 'unresolved',
          missing: [{ kind: 'connector', name: 'tickets' }],
          ambiguous: [],
        }),
    };
    const result = await setAgentPointer({ environment: 'local', version: 1 }, agent, ACTOR, {
      store,
    });
    expect(result).toMatchObject({
      status: 422,
      body: {
        error: { code: 'agent_definition_references_missing', details: ['connector:tickets'] },
      },
    });
    expect(store.applyAndPoint).toHaveBeenCalledTimes(1);
    expect(h.provider.audits()).toEqual([]);
  });
}
