import crypto from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { MemoryApproval } from './adapters/approval/memory';
import { draftBody } from './adapters/checker/checker.contract';
import { MemoryPolicy } from './adapters/policy/memory';
import { MemoryAgentStore } from './adapters/store/memory';
import { handleToolCall } from './shell';
import { callContextOf } from './testing/context';
import { makeMemoryPorts } from './testing/ports';

const WORKSPACE = crypto.randomUUID();
const OWNER = crypto.randomUUID();

function call(name: string, args: unknown = {}) {
  return { name, arguments: args, callId: crypto.randomUUID() };
}

describe('handleToolCall: concurrent calls of one run (SEC-10)', () => {
  it('lets exactly one of several parallel calls spend a single approval', async () => {
    const approval = new MemoryApproval();
    const store = new MemoryAgentStore();
    const save = vi.spyOn(store, 'save');
    const ports = makeMemoryPorts({ approval, store });
    const ctx = callContextOf(WORKSPACE, 'builder', OWNER);
    const args = { body: draftBody('Once') };
    approval.approve(ctx, { tool: 'draft_save', arguments: args });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => handleToolCall(call('draft_save', args), ctx, ports)),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    for (const result of results.filter((entry) => !entry.ok)) {
      expect(result).toMatchObject({ code: 'approval_required' });
    }
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('journals every parallel call and refuses the next one once the limit is passed', async () => {
    const limit = 3;
    const ports = makeMemoryPorts({ policy: new MemoryPolicy({ maxToolCallsPerRun: limit }) });
    const ctx = callContextOf(WORKSPACE, 'builder');
    const burst = limit + 4;

    await Promise.all(
      Array.from({ length: burst }, () => handleToolCall(call('catalog_list'), ctx, ports)),
    );

    // The count is read before the call is journaled, so a burst that starts together may pass the
    // limit by up to its own size; what must hold is that none of it goes unrecorded and that the
    // run is stopped afterwards.
    expect((await ports.audit.runCounts(ctx)).toolCalls).toBe(burst);
    expect(await handleToolCall(call('catalog_list'), ctx, ports)).toMatchObject({
      ok: false,
      code: 'tool_call_limit_reached',
    });
  });
});
