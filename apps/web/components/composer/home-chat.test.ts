/**
 * The chat screen's reading of a run's event stream (ENG-03, #302).
 *
 * The acceptance criterion this file answers is "the chat UI renders a fixture run identically
 * before and after, including tool calls". It is answered at the level this repository tests the
 * composer: a whole fixture stream is served by the SDK's own `fetchDouble`, followed through
 * `runs.follow` by `home-chat.tsx`'s own `followRunInto` — its frame fold, `parseAgentFrame` and
 * `@indx-workspace/react/run-model`'s pure folds included — and the resulting {@link Run} is
 * asserted. Nothing here parses an engine's message shape, which is the point of the unit.
 */
import { createClient } from '@indx-workspace/sdk';
import {
  droppedEventStreamResponse,
  eventStreamResponse,
  fetchDouble,
} from '@indx-workspace/sdk/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { followRunInto } from './home-chat';
import {
  beginRun,
  userMessage,
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

const DONE = 'event: done\ndata: {}\n\n';

/** Whether the stream's end has written its own badge: `Completed` after `done`, or a lost stream. */
const ended = (run: Run): boolean =>
  ['Completed', 'Disconnected'].includes(run.heading.status?.label ?? '');

/** Whether the server has already said the run did not succeed. */
const failed = (run: Run): boolean => /^(Failed|Cancelled)/u.test(run.heading.status?.label ?? '');

/**
 * Serve `respond` as run `r1`'s event stream, follow it with `followRunInto` into a fresh run, and
 * resolve with that run once `settled` holds. Each double serves its stream as one chunk, so every
 * frame after the settling one — `done` included — is folded in the same run of microtasks, which
 * the one macrotask turn at the end waits out.
 */
async function followed(
  respond: () => Response,
  settled: (run: Run) => boolean = ended,
): Promise<{ readonly run: Run; readonly requests: number }> {
  const double = fetchDouble(respond);
  const client = createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'session' },
    fetch: double.fetch,
  });
  let run = beginRun(OPENING, userMessage('m0-1', user, 'Summarise the open incidents.'));
  await new Promise<void>((resolve) => {
    followRunInto(
      'r1',
      assistant,
      (update) => {
        run = update(run);
        if (settled(run)) resolve();
      },
      client,
    );
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { run, requests: double.calls.length };
}

/** {@link followed} over a complete stream: `frames`, then the server's `done`. */
async function foldFixture(
  frames: readonly string[],
  settled: (run: Run) => boolean = ended,
): Promise<Run> {
  return (await followed(() => eventStreamResponse(frames.join('') + DONE), settled)).run;
}

describe('the chat screen over a fixture run', () => {
  let run: Run;
  beforeAll(async () => {
    run = await foldFixture(FIXTURE);
  });

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

  it('reports a frame it cannot read as a runtime line, not as a lost connection', async () => {
    // A `ContractViolationError` from the parser is drift in something the platform wrote. Turning
    // it into a transport error would tell the user to reconnect over a frame already delivered.
    const broken = await foldFixture([
      ...FIXTURE.slice(0, 2),
      sseFrame('agent.result', 8, { frame: 'agent.result', engine: ENGINE, raw: null }),
    ]);
    expect(broken.technical.runtimeEvents.map((line) => line.event)).toEqual(['frame.unreadable']);
    expect(broken.technical.sdkEvents).toHaveLength(2);
    expect(broken.messages.map((message) => message.kind)).toEqual(['user', 'agent']);
  });

  it('refuses a legacy frame rather than rendering half of it', async () => {
    // The server upgrades a pre-ENG-03 row on read, so a client only meets one if it is talking to
    // a control plane older than itself — which is a fact worth showing, not one to guess around.
    const legacy = await foldFixture([
      sseFrame('sdk-event', 1, { kind: 'event', type: 'assistant', event: { type: 'assistant' } }),
    ]);
    expect(legacy.technical.runtimeEvents.map((line) => line.event)).toEqual(['frame.unreadable']);
    expect(legacy.messages.map((message) => message.kind)).toEqual(['user']);
  });
});

describe('the chat screen over the end of a stream', () => {
  it('reads done as Completed when nothing said otherwise', async () => {
    const run = await foldFixture(FIXTURE.slice(0, 1));
    expect(run.heading.status).toEqual({ label: 'Completed', tone: 'ok', dot: false });
  });

  it('keeps a run-failed outcome when done follows it, and says why in the conversation', async () => {
    const run = await foldFixture(
      ['event: run-failed\ndata: {"status":"failed","message":"Not logged in."}\n\n'],
      failed,
    );
    expect(run.heading.status).toEqual({ label: 'Failed · failed', tone: 'danger', dot: false });
    expect(JSON.stringify(run.failure)).toContain('Not logged in.');
    expect(run.technical.runtimeEvents.map((line) => line.event)).toEqual(['run-failed']);
  });

  it('keeps a run.status failure when done follows it', async () => {
    const run = await foldFixture(
      ['event: run.status\nid: 9\ndata: {"status":"failed","error":"The model refused."}\n\n'],
      failed,
    );
    expect(run.heading.status).toEqual({ label: 'Failed · failed', tone: 'danger', dot: false });
    expect(JSON.stringify(run.failure)).toContain('The model refused.');
    expect(run.technical.runtimeEvents.map((line) => [line.id, line.event])).toEqual([
      ['9', 'run.status'],
    ]);
  });

  it('keeps Awaiting approval when the paused run ends its stream with done', async () => {
    const paused = (run: Run): boolean => run.heading.status?.label === 'Awaiting approval';
    const run = await foldFixture(
      ['event: run.status\nid: 4\ndata: {"status":"awaiting_approval","error":null}\n\n'],
      paused,
    );
    expect(run.heading.status).toEqual({ label: 'Awaiting approval', tone: 'warn', dot: false });
    expect(run.failure).toBeNull();
  });

  it('keeps Cancelled when an interrupted run ends its stream with done', async () => {
    const cancelled = (run: Run): boolean => run.heading.status?.label === 'Cancelled';
    const run = await foldFixture(
      ['event: run.status\nid: 5\ndata: {"status":"cancelled","error":null}\n\n'],
      cancelled,
    );
    expect(run.heading.status?.label).toBe('Cancelled');
  });

  it('reads a cancelled run as a deliberate stop, with no failure notice', async () => {
    const run = await foldFixture(
      ['event: run-failed\ndata: {"status":"cancelled","message":"Stopped."}\n\n'],
      failed,
    );
    expect(run.heading.status).toEqual({ label: 'Cancelled', tone: 'warn', dot: false });
    expect(run.failure).toBeNull();
  });

  it('keeps what arrived before a drop and reports the drop as Disconnected, without resuming', async () => {
    const { run, requests } = await followed(() =>
      droppedEventStreamResponse(FIXTURE.slice(0, 3).join('')),
    );
    expect(run.heading.status).toEqual({ label: 'Disconnected', tone: 'danger', dot: false });
    expect(run.messages.map((message) => message.kind)).toEqual(['user', 'agent']);
    expect(run.technical.sdkEvents).toHaveLength(3);
    expect(run.technical.runtimeEvents.map((line) => line.event)).toEqual(['transport.error']);
    expect(requests).toBe(1);
  });
});
