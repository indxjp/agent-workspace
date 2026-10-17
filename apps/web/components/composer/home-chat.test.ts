/**
 * The chat screen's reading of a run's event stream (ENG-03, #302).
 *
 * The acceptance criterion this file answers is "the chat UI renders a fixture run identically
 * before and after, including tool calls". It is answered at the level this repository tests the
 * composer: a whole fixture stream is driven through the real SSE parser, `home-chat.tsx`'s own
 * `parseAgentFrame`, and `@indx-workspace/react/run-model`'s pure folds — the same three steps the `onFrame` handler
 * performs — and the resulting {@link Run} is asserted. Nothing here parses an engine's message
 * shape, which is the point of the unit.
 */
import { parseSseFrame } from '@indx-workspace/sdk/events';
import { describe, expect, it } from 'vitest';

import { parseAgentFrame } from './home-chat';
import {
  assistantResponseFromAgentEvent,
  beginRun,
  eventLineFrom,
  formatEventTime,
  userMessage,
  withAssistantResponse,
  withRuntimeEvent,
  withSdkEvent,
  type Run,
  type RunOpening,
  type Speaker,
} from '@indx-workspace/react/run-model';

const ENGINE = 'claude-agent-sdk';
const assistant: Speaker = { initials: 'G', name: 'General' };
const user: Speaker = { initials: 'A', name: 'Alex' };

function sseFrame(name: string, id: number, data: unknown): string {
  return `event: ${name}\nid: ${String(id)}\ndata: ${JSON.stringify(data)}\n\n`;
}

function agentFrame(name: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { frame: name, engine: ENGINE, raw: { type: 'relayed', name }, ...fields };
}

/** One fixture run: a session, a spoken turn grown in two snapshots, a tool call and its result. */
const FIXTURE: readonly string[] = [
  sseFrame(
    'agent.session',
    1,
    agentFrame('agent.session', {
      engineSessionId: 'sess_1',
      model: 'claude-opus-5',
    }),
  ),
  sseFrame(
    'agent.message',
    2,
    agentFrame('agent.message', {
      messageId: 'msg_1',
      role: 'assistant',
      blocks: [
        { type: 'reasoning', text: 'private' },
        { type: 'text', text: 'Reading' },
      ],
    }),
  ),
  sseFrame(
    'agent.message',
    3,
    agentFrame('agent.message', {
      messageId: 'msg_1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Reading the incidents.' }],
    }),
  ),
  sseFrame(
    'agent.tool.call',
    4,
    agentFrame('agent.tool.call', {
      toolCallId: 'tool_1',
      name: 'Read',
      kind: 'read',
      input: { path: 'incidents.md' },
    }),
  ),
  sseFrame(
    'agent.tool.result',
    5,
    agentFrame('agent.tool.result', {
      toolCallId: 'tool_1',
      status: 'completed',
      output: 'two open',
      isError: false,
    }),
  ),
  sseFrame(
    'agent.usage',
    6,
    agentFrame('agent.usage', {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      reasoningTokens: null,
    }),
  ),
  sseFrame(
    'agent.result',
    7,
    agentFrame('agent.result', {
      stopReason: 'end_turn',
      turns: 1,
      engineCostUsd: 0.0125,
    }),
  ),
];

const OPENING: RunOpening = {
  heading: { title: 'Incident triage', subtitle: '', status: null, actions: [] },
  followUp: { placeholder: 'Ask a follow-up.', actions: [], status: 'Standard Sandbox' },
};

/**
 * The three steps `home-chat.tsx`'s `onFrame` performs for a relayed frame, over a whole stream.
 *
 * Written out here rather than reached through the component, because the component needs a network
 * and a DOM to reach them and the question this file asks is about the fold, not about React.
 */
function foldFixture(frames: readonly string[]): Run {
  let run = beginRun(OPENING, userMessage('m0-1', user, 'Summarise the open incidents.'));
  for (const [index, raw] of frames.entries()) {
    const parsed = parseSseFrame(raw);
    if (parsed === null) throw new Error(`fixture frame ${String(index)} did not parse`);
    const event = parseAgentFrame(parsed);
    const time = formatEventTime(new Date(0));
    if (event.kind === 'unreadable') {
      run = withRuntimeEvent(
        run,
        eventLineFrom(`unreadable-${String(index)}`, time, 'frame.unreadable', event.message),
      );
      continue;
    }
    const response = assistantResponseFromAgentEvent(event.event);
    run = withSdkEvent(
      run,
      eventLineFrom(parsed.id ?? String(index), time, parsed.event, event.event.raw),
    );
    if (response !== null) run = withAssistantResponse(run, assistant, response);
  }
  return run;
}

describe('the chat screen over a fixture run', () => {
  const run = foldFixture(FIXTURE);

  it('renders the prompt and exactly one assistant turn, grown in place', () => {
    // Two `agent.message` frames share `msg_1`, so the second replaces the first rather than
    // appending a duplicate — the snapshot behaviour the run view has always had.
    expect(run.messages.map((message) => message.kind)).toEqual(['user', 'agent']);
    expect(JSON.stringify(run.messages[1])).toContain('Reading the incidents.');
    expect(JSON.stringify(run.messages[1])).not.toContain('Reading the incidents.Reading');
  });

  it('keeps reasoning, tool calls, usage and the result out of the conversation', () => {
    const conversation = JSON.stringify(run.messages);
    for (const leak of ['private', 'incidents.md', 'two open', 'end_turn', 'sess_1']) {
      expect(conversation, leak).not.toContain(leak);
    }
  });

  it('logs every frame of the run in Technical details, engine-native payload and all', () => {
    // One line per frame, under the frame's own name, carrying what the engine said. A tool call is
    // visible to the operator without being a chat turn.
    expect(run.technical.sdkEvents.map((line) => line.event)).toEqual([
      'agent.session',
      'agent.message',
      'agent.message',
      'agent.tool.call',
      'agent.tool.result',
      'agent.usage',
      'agent.result',
    ]);
    expect(run.technical.sdkEvents.map((line) => line.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
    ]);
    expect(run.technical.sdkEvents[3]?.detail).toContain('agent.tool.call');
    expect(run.technical.runtimeEvents).toEqual([]);
  });

  it('reports a frame it cannot read as a runtime line, not as a lost connection', () => {
    // A `ContractViolationError` from the parser is drift in something the platform wrote. Turning
    // it into a transport error would tell the user to reconnect over a frame already delivered.
    const broken = foldFixture([
      ...FIXTURE.slice(0, 2),
      sseFrame('agent.result', 8, { frame: 'agent.result', engine: ENGINE, raw: null }),
    ]);
    expect(broken.technical.runtimeEvents.map((line) => line.event)).toEqual(['frame.unreadable']);
    expect(broken.technical.sdkEvents).toHaveLength(2);
    expect(broken.messages.map((message) => message.kind)).toEqual(['user', 'agent']);
  });

  it('refuses a legacy frame rather than rendering half of it', () => {
    // The server upgrades a pre-ENG-03 row on read, so a client only meets one if it is talking to
    // a control plane older than itself — which is a fact worth showing, not one to guess around.
    const legacy = foldFixture([
      sseFrame('sdk-event', 1, { kind: 'event', type: 'assistant', event: { type: 'assistant' } }),
    ]);
    expect(legacy.technical.runtimeEvents.map((line) => line.event)).toEqual(['frame.unreadable']);
    expect(legacy.messages.map((message) => message.kind)).toEqual(['user']);
  });
});
