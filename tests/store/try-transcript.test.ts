/** A demo turn as its run's events arrive: tool steps, an approval wait, answers and the cap. */
import { describe, expect, it } from 'vitest';
import type { RunEventFrame } from '@indx-workspace/sdk/events';

import {
  applyFrame,
  beginTurn,
  continueTurn,
} from '../../examples/store/app/agents/[slug]/try/transcript.ts';

const base = { engine: 'claude-agent-sdk', raw: {} };
const runtime = (name: string, data: object): RunEventFrame => ({
  kind: 'runtime',
  id: null,
  name,
  data: { frame: name, ...base, ...data },
});
const status = (value: string): RunEventFrame =>
  ({ kind: 'run-status', id: '1', data: { status: value, error: null } }) as RunEventFrame;

const call = runtime('agent.tool.call', {
  toolCallId: 't1',
  name: 'search_deals',
  kind: 'read',
  input: { q: 'acme' },
});

describe('applyFrame', () => {
  it('shows a tool call as it starts and fills its output when it answers', () => {
    const started = applyFrame(beginTurn('r1', 'hi'), call);
    expect(started.tools).toEqual([
      { id: 't1', name: 'search_deals', input: { q: 'acme' }, output: null, isError: false },
    ]);
    const answered = applyFrame(
      started,
      runtime('agent.tool.result', {
        toolCallId: 't1',
        status: 'completed',
        output: '3 deals',
        isError: false,
      }),
    );
    expect(answered.tools[0]).toMatchObject({ output: '3 deals', isError: false });
    const failed = applyFrame(
      started,
      runtime('agent.tool.result', {
        toolCallId: 't1',
        status: 'failed',
        output: 'boom',
        isError: false,
      }),
    );
    expect(failed.tools[0]?.isError).toBe(true);
  });

  it('holds an approval wait until a decision continues the turn', () => {
    const waiting = [
      runtime('agent.approval.requested', {
        toolCallId: 't2',
        toolName: 'update_deal',
        canonicalCall: 'update_deal {"id":1}',
      }),
      status('awaiting_approval'),
    ].reduce(applyFrame, beginTurn('r1', 'hi'));
    expect(waiting.status).toBe('awaiting_approval');
    expect(waiting.pendingApproval).toEqual({
      toolName: 'update_deal',
      canonicalCall: 'update_deal {"id":1}',
    });
    const resumed = continueTurn(waiting, 'r2');
    expect(resumed).toMatchObject({ runId: 'r2', status: 'running', pendingApproval: null });
    expect(resumed.prompt).toBe('hi');
  });

  it('replaces a repeated answer instead of appending, and ignores reasoning and user text', () => {
    const message = (id: string, role: string, text: string, type = 'text') =>
      runtime('agent.message', { messageId: id, role, blocks: [{ type, text }] });
    const turn = [
      message('m1', 'assistant', 'Hel'),
      message('m1', 'assistant', 'Hello'),
      message('m2', 'assistant', 'thinking', 'reasoning'),
      message('m3', 'user', 'echo'),
      message('m4', 'assistant', 'Done'),
    ].reduce(applyFrame, beginTurn('r1', 'hi'));
    expect(turn.answers).toEqual([
      { id: 'm1', text: 'Hello' },
      { id: 'm4', text: 'Done' },
    ]);
  });

  it('records the stop reason of a run that used its turns', () => {
    const turn = applyFrame(
      beginTurn('r1', 'hi'),
      runtime('agent.result', { stopReason: 'max_turns', turns: 5, engineCostUsd: null }),
    );
    expect(turn.stopReason).toBe('max_turns');
  });

  it('leaves the turn alone for a malformed or unknown frame', () => {
    const turn = beginTurn('r1', 'hi');
    expect(applyFrame(turn, runtime('agent.tool.call', { toolCallId: 5 }))).toBe(turn);
    expect(applyFrame(turn, { kind: 'done' })).toBe(turn);
  });
});
