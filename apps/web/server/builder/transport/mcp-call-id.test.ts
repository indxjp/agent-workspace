import { MISSING_TOOL_USE_ID, serveBuilderMcp } from './mcp';
import { describe, expect, it } from 'vitest';

import {
  allow,
  call,
  door,
  recordedIds,
  resetDoorAfterEach,
  rpc,
  spyPorts,
  toolAnswer,
} from './mcp.test-support';

resetDoorAfterEach();

describe('the call id of a Builder tool call (#1846)', () => {
  it("journals the engine's tool-use id as the call id, so a retry is the same call", async () => {
    const { ports, reached } = spyPorts();
    const params = {
      name: 'catalog_list',
      arguments: {},
      _meta: { 'claudecode/toolUseId': 'toolu_01' },
    };
    for (let i = 0; i < 2; i += 1) {
      await serveBuilderMcp(rpc(call('tools/call', params)), door(allow, { ports }));
    }
    // The repeat is not stored under the taken id, so it is journaled again under a derived one.
    const ids = recordedIds(reached);
    expect(ids.slice(0, 2)).toEqual(['toolu_01', 'toolu_01']);
    expect(ids).toHaveLength(3);
    expect(ids[2]).toMatch(/^toolu_01:[0-9a-f-]{36}$/);
  });

  it.each([
    ['another _meta key', { _meta: { callId: 'client-id' } }],
    ['an empty id', { _meta: { 'claudecode/toolUseId': '' } }],
    ['an id over 128 characters', { _meta: { 'claudecode/toolUseId': 'x'.repeat(129) } }],
    ['an id that is not a string', { _meta: { 'claudecode/toolUseId': 7 } }],
  ])('mints a fresh call id per call when the request carries %s', async (_label, meta) => {
    const { ports, reached, journalled } = spyPorts();
    const params = { name: 'catalog_list', arguments: {}, ...meta };
    for (let i = 0; i < 2; i += 1) {
      await serveBuilderMcp(rpc(call('tools/call', params)), door(allow, { ports }));
    }
    const ids = recordedIds(reached);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).not.toMatch(/^(client-id|7)$/);
    expect(await journalled()).toBe(2);
  });

  it.each([
    ['no _meta', {}],
    ['another _meta key', { _meta: { callId: 'client-id' } }],
    ['an empty id', { _meta: { 'claudecode/toolUseId': '' } }],
    ['an id over 128 characters', { _meta: { 'claudecode/toolUseId': 'x'.repeat(129) } }],
    ['an id that is not a string', { _meta: { 'claudecode/toolUseId': 7 } }],
  ])(
    'refuses a write or spend tool when the request carries %s, before any port (AUD-07)',
    async (_label, meta) => {
      const { ports, reached, journalled } = spyPorts();
      for (const name of ['draft_save', 'evals_run', 'trial_run']) {
        const params = { name, arguments: {}, ...meta };
        const response = await serveBuilderMcp(
          rpc(call('tools/call', params)),
          door(allow, { ports }),
        );
        const answer = await toolAnswer(response);
        expect(answer.isError, name).toBe(true);
        expect(answer.result, name).toMatchObject({
          ok: false,
          code: 'invalid_arguments',
          details: [MISSING_TOOL_USE_ID],
        });
      }
      expect(reached).not.toHaveBeenCalled();
      expect(await journalled()).toBe(0);
    },
  );

  it('lets a write that carries a tool-use id through to the core', async () => {
    const { ports, reached } = spyPorts();
    const params = {
      name: 'draft_save',
      arguments: {},
      _meta: { 'claudecode/toolUseId': 'toolu_02' },
    };
    const answer = await toolAnswer(
      await serveBuilderMcp(rpc(call('tools/call', params)), door(allow, { ports })),
    );
    expect(answer.result).toMatchObject({ ok: false, code: 'invalid_arguments' });
    expect(answer.result).not.toMatchObject({ details: [MISSING_TOOL_USE_ID] });
    expect(recordedIds(reached)).toEqual(['toolu_02']);
  });
});
