import { describe, expect, it } from 'vitest';

import { ENGINE_IDS } from '@indx-workspace/contracts/engines';
import type { RunEventFrame } from '@indx-workspace/sdk/events';

import {
  SURFACE_VISITOR,
  answerPlacement,
  emptySurfaceTurn,
  messageParagraphs,
  pendingTurn,
  reduceSurfaceRunFrame,
  reduceSurfaceTurnFrame,
  surfaceAgentSpeaker,
  visibleSurfaceFailure,
  withSurfaceFailure,
  withVisitorMessage,
  type SurfaceRunState,
  type SurfaceTurn,
} from './surface-chat-model.js';
import { surfaceStrings } from './locale.js';

const ASSISTANT = surfaceAgentSpeaker('Support triage');

function agentMessage(messageId: string, text: string): RunEventFrame {
  return {
    kind: 'runtime',
    id: '7',
    name: 'agent.message',
    data: {
      frame: 'agent.message',
      engine: ENGINE_IDS[0],
      raw: { type: 'assistant' },
      messageId,
      role: 'assistant',
      blocks: [{ type: 'text', text }],
    },
  };
}

function opened(): SurfaceRunState {
  return {
    run: withVisitorMessage(null, 'Support triage', 'visitor-1', 'Where is my order?'),
    outcomeKnown: false,
  };
}

function fold(
  frames: readonly RunEventFrame[],
  state: SurfaceRunState = opened(),
): SurfaceRunState {
  return frames.reduce((current, frame) => reduceSurfaceRunFrame(current, frame, ASSISTANT), state);
}

describe('the surface chat model (S1-17, #455)', () => {
  it('opens a conversation with the visitor message and appends the next one', () => {
    const first = opened().run;
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({ kind: 'user', speaker: SURFACE_VISITOR });
    expect(first.heading.title).toBe('Support triage');

    const second = withVisitorMessage(first, 'Support triage', 'visitor-2', 'And the invoice?');
    expect(second.messages.map(messageParagraphs)).toEqual([
      ['Where is my order?'],
      ['And the invoice?'],
    ]);
  });

  it('streams the assistant text from SDK frames, replacing a repeated snapshot', () => {
    const state = fold([
      { kind: 'run-status', id: '1', data: { status: 'running', error: null } },
      agentMessage('msg_1', 'Looking'),
      agentMessage('msg_1', 'Looking it up: it ships today.'),
      { kind: 'run-status', id: '4', data: { status: 'completed', error: null } },
      { kind: 'done' },
    ]);

    expect(state.run.messages.map(messageParagraphs)).toEqual([
      ['Where is my order?'],
      ['Looking it up: it ships today.'],
    ]);
    expect(state.run.messages[1]).toMatchObject({ kind: 'agent', speaker: ASSISTANT });
    expect(state.run.heading.status?.label).toBe('Completed');
    expect(state.run.failure).toBeNull();
  });

  it('skips a relayed frame that does not satisfy its contract, and keeps reading', () => {
    const state = fold([
      { kind: 'runtime', id: '2', name: 'agent.message', data: { frame: 'agent.message' } },
      agentMessage('msg_2', 'Still here.'),
    ]);
    expect(state.run.messages.map(messageParagraphs)).toEqual([
      ['Where is my order?'],
      ['Still here.'],
    ]);
  });

  it('shows a run-failed frame as the failure, and done does not overwrite it', () => {
    const state = fold([
      {
        kind: 'run-failed',
        data: { status: 'failed', message: 'model_unavailable: the model is gone' },
      },
      { kind: 'done' },
    ]);
    expect(state.outcomeKnown).toBe(true);
    expect(state.run.heading.status?.label).toBe('Failed · failed');
    expect(state.run.failure).toEqual({
      code: 'model_unavailable',
      message: 'the model is gone',
    });
  });

  it('reads a failed run-status with an error as the failure', () => {
    const state = fold([
      { kind: 'run-status', id: '3', data: { status: 'failed', error: 'the runtime stopped' } },
      { kind: 'done' },
    ]);
    expect(state.run.failure).toEqual({ code: null, message: 'the runtime stopped' });
    expect(state.run.heading.status?.tone).toBe('danger');
  });

  it('shows no failure for a cancelled run', () => {
    const state = fold([{ kind: 'run-failed', data: { status: 'cancelled', message: 'stopped' } }]);
    expect(state.run.failure).toBeNull();
    expect(state.run.heading.status?.label).toBe('Cancelled');
  });

  it('ignores a stream reset', () => {
    const before = opened();
    expect(
      reduceSurfaceRunFrame(
        before,
        { kind: 'stream-reset', data: { reason: 'cursor-expired', resumedAfter: null } },
        ASSISTANT,
      ),
    ).toBe(before);
  });

  it('names a refusal before any frame with its code', () => {
    const run = withSurfaceFailure(
      opened().run,
      'agent "Support triage" has no runtime profile.',
      'agent_runtime_profile_missing',
    );
    expect(run.failure).toEqual({
      code: 'agent_runtime_profile_missing',
      message: 'agent "Support triage" has no runtime profile.',
    });
  });

  it('clears the previous failure and status when the next message starts a run', () => {
    const refused = withSurfaceFailure(opened().run, 'The session request did not complete.', null);
    const next = withVisitorMessage(refused, 'Support triage', 'visitor-2', 'Where is it now?');
    expect(next.failure).toBeNull();
    expect(next.heading.status).toBeNull();

    const state = fold(
      [
        { kind: 'run-status', id: '1', data: { status: 'running', error: null } },
        { kind: 'run-status', id: '2', data: { status: 'completed', error: null } },
        { kind: 'done' },
      ],
      { run: next, outcomeKnown: false },
    );
    expect(state.run.heading.status?.label).toBe('Completed');
    expect(state.run.failure).toBeNull();
  });

  it('derives initials from the agent name', () => {
    expect(surfaceAgentSpeaker('Support triage').initials).toBe('ST');
    expect(surfaceAgentSpeaker('assistant').initials).toBe('A');
  });
});

function toolCall(toolCallId: string, name: string, input: unknown): RunEventFrame {
  return {
    kind: 'runtime',
    id: '5',
    name: 'agent.tool.call',
    data: {
      frame: 'agent.tool.call',
      engine: ENGINE_IDS[0],
      raw: null,
      toolCallId,
      name,
      kind: 'other',
      input,
    },
  };
}

function toolResult(toolCallId: string, output: string, isError = false): RunEventFrame {
  return {
    kind: 'runtime',
    id: '6',
    name: 'agent.tool.result',
    data: {
      frame: 'agent.tool.result',
      engine: ENGINE_IDS[0],
      raw: null,
      toolCallId,
      status: 'completed',
      output,
      isError,
    },
  };
}

function foldTurn(frames: readonly RunEventFrame[]): SurfaceTurn {
  return frames.reduce(reduceSurfaceTurnFrame, emptySurfaceTurn('run-1'));
}

describe('the surface turn model (#540)', () => {
  it('pairs a tool call with its result, and records an answer snapshot once', () => {
    const turn = foldTurn([
      toolCall('call_1', 'lookup_order', { id: 42 }),
      toolResult('call_1', '{"status":"shipped"}'),
      agentMessage('msg_1', 'Looking'),
      agentMessage('msg_1', 'It shipped.'),
    ]);
    expect(turn).toEqual({
      runId: 'run-1',
      answerIds: ['assistant-msg_1'],
      tools: [
        {
          id: 'call_1',
          name: 'lookup_order',
          input: { id: 42 },
          output: '{"status":"shipped"}',
          isError: false,
        },
      ],
    });
  });

  it('ignores an unmatched result, a malformed tool frame and the platform frames', () => {
    const before = foldTurn([toolCall('call_1', 'lookup_order', {})]);
    expect(reduceSurfaceTurnFrame(before, toolResult('call_9', 'x'))).toBe(before);
    const malformed: RunEventFrame = {
      kind: 'runtime',
      id: '7',
      name: 'agent.tool.call',
      data: { frame: 'agent.tool.call' },
    };
    expect(reduceSurfaceTurnFrame(before, malformed)).toBe(before);
    expect(reduceSurfaceTurnFrame(before, { kind: 'done' })).toBe(before);
    const failed = foldTurn([toolCall('a', 'x', 1), toolResult('a', 'boom', true)]);
    expect(failed.tools[0]).toMatchObject({ output: 'boom', isError: true });
  });

  it('places a turn by its first and last answer, and a turn with no answer is pending', () => {
    const answered: SurfaceTurn = {
      runId: 'run-1',
      answerIds: ['assistant-a', 'assistant-b'],
      tools: [],
    };
    const working: SurfaceTurn = {
      runId: 'run-2',
      answerIds: [],
      tools: [{ id: 'c', name: 'x', input: null, output: null, isError: false }],
    };
    const placement = answerPlacement([answered, working]);
    expect(placement.first.get('assistant-a')).toBe(answered);
    expect(placement.last.get('assistant-b')).toBe(answered);
    expect(placement.first.has('assistant-b')).toBe(false);
    expect(pendingTurn([answered, working])).toBe(working);
    expect(pendingTurn([working, answered])).toBeNull();
    expect(pendingTurn([emptySurfaceTurn('run-3')])).toBeNull();
    expect(pendingTurn([])).toBeNull();
  });
});

describe('visibleSurfaceFailure (issue #661)', () => {
  const strings = surfaceStrings('en');
  const unresolved = {
    code: 'model_connection_unresolved',
    message: 'no model can be resolved for this run.',
  };

  it('tells the try page under aw dev to set ANTHROPIC_API_KEY and restart', () => {
    const shown = visibleSurfaceFailure(unresolved, 'local', strings);
    expect(shown.code).toBe('model_connection_unresolved');
    expect(shown.message).toContain(unresolved.message);
    expect(shown.message).toContain('set ANTHROPIC_API_KEY');
    expect(shown.message).toContain('restart aw dev');
    const rejected = { code: 'model_credential_rejected', message: 'x' };
    expect(visibleSurfaceFailure(rejected, 'local', strings).message).toContain(
      'ANTHROPIC_API_KEY',
    );
    // A model the connection does not offer is not a key problem.
    const unavailable = { code: 'model_unavailable', message: 'no such model.' };
    expect(visibleSurfaceFailure(unavailable, 'local', strings)).toEqual(unavailable);
  });

  it('tells the try page to check the network, not the key, for a provider it cannot connect to', () => {
    const failed = { code: 'model_connection_failed', message: 'could not be connected to.' };
    for (const locale of ['en', 'ja'] as const) {
      const localised = surfaceStrings(locale);
      const shown = visibleSurfaceFailure(failed, 'local', localised);
      expect(shown.code).toBe('model_connection_failed');
      expect(shown.message).toBe(`${failed.message} ${localised.tryModelReachFix}`);
      expect(shown.message).not.toContain('ANTHROPIC_API_KEY');
    }
    expect(visibleSurfaceFailure(failed, undefined, strings)).toEqual({
      code: null,
      message: strings.unavailable,
    });
  });

  it('shows the widget a generic sentence, with no code and no admin advice', () => {
    const codes = [
      'model_connection_unresolved',
      'model_connection_failed',
      'model_unavailable',
      'model_credential_rejected',
    ];
    for (const code of codes) {
      const shown = visibleSurfaceFailure({ code, message: 'Choose a model.' }, undefined, strings);
      expect(shown).toEqual({ code: null, message: strings.unavailable });
    }
  });

  it('leaves every other failure as it was', () => {
    const other = { code: 'surface_rate_limited', message: 'Slow down.' };
    expect(visibleSurfaceFailure(other, undefined, strings)).toEqual(other);
    const plain = { code: null, message: 'Failed to fetch' };
    expect(visibleSurfaceFailure(plain, 'local', strings)).toEqual(plain);
  });
});
