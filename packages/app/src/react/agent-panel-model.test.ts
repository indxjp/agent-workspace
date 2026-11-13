import { badgeForRunStatus } from '@indx-workspace/react/run-model';
import type { RunEventFrame } from '@indx-workspace/sdk/events';
import { describe, expect, it } from 'vitest';

import type { AgentPanelRun } from '../agent-panel-wire.js';
import {
  agentPanelReducer,
  INITIAL_AGENT_PANEL_STATE,
  isStuck,
  MAX_RECONNECTS,
  maySend,
  needsApprovalCall,
  nextReconnect,
  type AgentPanelAction,
  type AgentPanelState,
  type FrameContext,
} from './agent-panel-model.js';

const context: FrameContext = {
  agent: { initials: 'TR', name: 'Triage' },
  badge: (status) => ({ ...badgeForRunStatus(status), label: `[${status}]` }),
};
const you = { initials: 'YO', name: 'You' };
const RUN = '33333333-3333-4333-8333-333333333333';
const CALL = { toolName: 'ticket_update', canonicalCall: '{"assignee":"Net"}' };

function panelRun(overrides: Partial<AgentPanelRun> = {}): AgentPanelRun {
  return { id: RUN, status: 'queued', pendingApproval: null, error: null, ...overrides };
}

function runtime(id: string, data: unknown): RunEventFrame {
  return { kind: 'runtime', id, name: String((data as { frame: string }).frame), data };
}

const toolCall = (id: string, toolCallId: string, name: string): RunEventFrame =>
  runtime(id, {
    frame: 'agent.tool.call',
    engine: 'claude-agent-sdk',
    raw: null,
    toolCallId,
    name,
    kind: 'read',
    input: { q: name },
  });
const toolResult = (id: string, toolCallId: string): RunEventFrame =>
  runtime(id, {
    frame: 'agent.tool.result',
    engine: 'claude-agent-sdk',
    raw: null,
    toolCallId,
    status: 'completed',
    output: 'found',
    isError: false,
  });
const message = (id: string, messageId: string, text: string): RunEventFrame =>
  runtime(id, {
    frame: 'agent.message',
    engine: 'claude-agent-sdk',
    raw: null,
    messageId,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
  });
const status = (
  id: string,
  value: AgentPanelRun['status'],
  error: string | null = null,
): RunEventFrame => ({
  kind: 'run-status',
  id,
  data: { status: value, error },
});

function fold(state: AgentPanelState, ...actions: readonly AgentPanelAction[]): AgentPanelState {
  return actions.reduce(agentPanelReducer, state);
}

const frames = (...list: readonly RunEventFrame[]): AgentPanelAction[] =>
  list.map((frame) => ({ type: 'frame', frame, context }));

/** A panel that sent one prompt and is following its run. */
function following(): AgentPanelState {
  return fold(
    INITIAL_AGENT_PANEL_STATE,
    { type: 'send', messageId: 'm1', prompt: '  classify and route ', you, title: 'Triage' },
    { type: 'started', run: panelRun(), context },
  );
}

describe('agentPanelReducer: frames to the transcript', () => {
  it('starts the transcript with the prompt, then folds tool steps, the answer and the status', () => {
    const state = fold(
      following(),
      ...frames(
        status('1', 'running'),
        toolCall('2', 't1', 'reading ticket'),
        toolResult('3', 't1'),
        toolCall('4', 't2', 'searching kb_article'),
        message('5', 'msg-1', 'Routed to Net.'),
        message('6', 'msg-1', 'Routed to Net, priority p2.'),
        status('7', 'completed'),
      ),
    );
    expect(state.phase).toBe('following');
    expect(state.status).toBe('completed');
    expect(state.lastEventId).toBe('7');
    expect(state.transcript?.heading.status?.label).toBe('[completed]');
    expect(state.transcript?.messages.map((m) => m.kind)).toEqual(['user', 'agent']);
    const [first, answer] = state.transcript?.messages ?? [];
    expect(first?.kind === 'user' && first.paragraphs[0]?.[0]?.text).toBe('classify and route');
    expect(answer?.kind === 'agent' && answer.speaker.name).toBe('Triage');
    expect(JSON.stringify(answer)).toContain('Routed to Net, priority p2.');
    expect(state.tools.map((step) => [step.name, step.output])).toEqual([
      ['reading ticket', 'found'],
      ['searching kb_article', null],
    ]);
  });

  it('shows a failure from run-failed and from a failed run.status, and moves past a broken frame', () => {
    const failed = fold(
      following(),
      ...frames({
        kind: 'run-failed',
        data: { status: 'failed', message: 'model_unavailable: no model' },
      }),
    );
    expect(failed.status).toBe('failed');
    expect(failed.transcript?.failure).toEqual({ code: 'model_unavailable', message: 'no model' });

    const errored = fold(following(), ...frames(status('9', 'failed', 'The run failed.')));
    expect(errored.transcript?.failure?.message).toBe('The run failed.');

    const broken = fold(
      following(),
      ...frames(runtime('10', { frame: 'agent.message', role: 'nobody' })),
    );
    expect(broken.lastEventId).toBe('10');
    expect(broken.transcript?.messages).toHaveLength(1);
  });

  it('clears what the run showed on stream-reset, and resumes after the cursor it names', () => {
    const before = fold(
      following(),
      ...frames(toolCall('2', 't1', 'reading ticket'), message('3', 'msg-1', 'Half an answer')),
    );
    expect(before.transcript?.messages).toHaveLength(2);
    const reset = fold(
      before,
      ...frames({ kind: 'stream-reset', data: { reason: 'expired', resumedAfter: '1' } }),
    );
    expect(reset.transcript?.messages.map((m) => m.kind)).toEqual(['user']);
    expect(reset.tools).toEqual([]);
    expect(reset.lastEventId).toBe('1');
  });
});

describe('agentPanelReducer: approvals', () => {
  it('asks for the call on awaiting_approval, holds it once read, and follows the continuation', () => {
    const paused = fold(following(), ...frames(status('5', 'awaiting_approval')));
    expect(paused.transcript?.heading.status?.label).toBe('[awaiting_approval]');
    expect(needsApprovalCall(paused)).toBe(true);

    const read = fold(paused, {
      type: 'run',
      run: panelRun({ status: 'awaiting_approval', pendingApproval: CALL }),
      context,
    });
    expect(read.approval).toEqual(CALL);
    expect(read.phase).toBe('idle');
    expect(needsApprovalCall(read)).toBe(false);
    expect(isStuck(read, true)).toBe(false);
    expect(isStuck(read, false)).toBe(true);
    expect(maySend(read)).toBe(false);

    const deciding = fold(read, { type: 'decide' });
    expect(deciding.phase).toBe('deciding');
    const continued = fold(deciding, {
      type: 'started',
      run: panelRun({ id: '44444444-4444-4444-8444-444444444444', status: 'queued' }),
      context,
    });
    expect(continued.runId).toBe('44444444-4444-4444-8444-444444444444');
    expect(continued.approval).toBeNull();
    expect(continued.phase).toBe('following');
    expect(continued.lastEventId).toBeNull();
    // The continuation's reset keeps the conversation before it.
    const answered = fold(
      continued,
      ...frames(message('1', 'msg-2', 'Done.'), {
        kind: 'stream-reset',
        data: { reason: 'x', resumedAfter: null },
      }),
    );
    expect(answered.transcript?.messages).toHaveLength(1);
  });

  it('keeps the prompt on a refused decision and names the problem', () => {
    const read = fold(following(), ...frames(status('5', 'awaiting_approval')), {
      type: 'run',
      run: panelRun({ status: 'awaiting_approval', pendingApproval: CALL }),
      context,
    });
    const refused = fold(
      read,
      { type: 'decide' },
      { type: 'refused', code: 'approval_already_decided' },
    );
    expect(refused.approval).toEqual(CALL);
    expect(refused.problem).toBe('approval_already_decided');
    expect(refused.phase).toBe('idle');
  });

  it('ignores the answer for a run that is no longer the current one', () => {
    const state = following();
    expect(
      fold(state, { type: 'run', run: panelRun({ id: 'other', status: 'completed' }), context }),
    ).toBe(state);
  });
});

describe('agentPanelReducer: refusals and resuming', () => {
  it('takes a refused prompt (409 session_busy) off the transcript; the next one may be sent', () => {
    const refused = fold(
      INITIAL_AGENT_PANEL_STATE,
      { type: 'send', messageId: 'm1', prompt: 'classify', you, title: 'Triage' },
      { type: 'refused', code: 'session_busy' },
    );
    expect(refused.transcript).toBeNull();
    expect(refused.problem).toBe('session_busy');
    expect(maySend(refused)).toBe(true);

    const done = fold(following(), ...frames(status('2', 'completed')), {
      type: 'run',
      run: panelRun({ status: 'completed' }),
      context,
    });
    const second = fold(
      done,
      { type: 'send', messageId: 'm2', prompt: 'again', you, title: 'Triage' },
      { type: 'refused', code: 'session_busy' },
    );
    expect(second.transcript?.messages).toHaveLength(1);
  });

  it('follows a live run again from its cursor after a lost stream is checked', () => {
    const lost = fold(following(), ...frames(status('3', 'running')), {
      type: 'refused',
      code: 'stream_lost',
    });
    expect(isStuck(lost, true)).toBe(true);
    const resumed = fold(lost, { type: 'run', run: panelRun({ status: 'running' }), context });
    expect(resumed.phase).toBe('following');
    expect(resumed.problem).toBeNull();
    expect(resumed.lastEventId).toBe('3');
  });
});

describe('nextReconnect', () => {
  it(`allows ${String(MAX_RECONNECTS)} reconnects in a row that deliver nothing, and resets on progress`, () => {
    let failures = 0;
    for (let attempt = 1; attempt <= MAX_RECONNECTS; attempt += 1) {
      const next = nextReconnect(failures, false);
      expect(next).toBe(attempt);
      failures = next ?? failures;
    }
    expect(nextReconnect(failures, false)).toBeNull();
    expect(nextReconnect(failures, true)).toBe(1);
  });
});
