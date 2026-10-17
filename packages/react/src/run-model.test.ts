/**
 * W1-UI-05 — the pure half of "the run path": turning what a real frame from
 * `GET /api/runs/:id/events` or `POST /api/agents/:id/runs` said into an update to a {@link Run}.
 * `./live.ts` is the transport these are fed from; nothing here touches a network, so every
 * assertion below runs without one.
 */
import type { AgentEvent } from '@indx-workspace/sdk/events';
import { describe, expect, it } from 'vitest';

import {
  assistantResponseFromAgentEvent,
  badgeForRunStatus,
  beginRun,
  eventLineFrom,
  failureBadge,
  formatEventTime,
  parseRunFailedPayload,
  parseRunStatusPayload,
  userMessage,
  withAssistantResponse,
  withRuntimeEvent,
  withSdkEvent,
  withStatus,
  type Run,
  type RunOpening,
  type Speaker,
} from './run-model.js';

const USER: Speaker = { initials: 'AI', name: 'Aya Ito' };

const OPENING: RunOpening = {
  heading: { title: 'General', subtitle: '', status: null, actions: [] },
  followUp: {
    placeholder: 'Ask a follow-up.',
    actions: [],
    status: 'Standard Sandbox · read-only',
  },
};

function freshRun(): Run {
  return beginRun(OPENING, userMessage('m0-1', USER, 'Summarise the contracts.'));
}

describe('withStatus', () => {
  it('replaces the heading badge and nothing else', () => {
    const run = freshRun();
    const badge = { label: 'Running', tone: 'info' as const, dot: true };
    const updated = withStatus(run, badge);
    expect(updated.heading.status).toEqual(badge);
    expect(updated.heading.title).toBe(run.heading.title);
    expect(updated.messages).toBe(run.messages);
  });

  it('clears the badge with null, exactly like a run that has not heard from the server yet', () => {
    const run = withStatus(freshRun(), { label: 'Queued', tone: 'muted', dot: true });
    expect(withStatus(run, null).heading.status).toBeNull();
  });
});

describe('withAssistantResponse — fed by the SDK parser this module re-exports', () => {
  // The parser's own cases (visible text only, telemetry ignored, malformed input) live with it in
  // `packages/sdk/src/events/agent-event.test.ts`; what is checked here is the seam and the turn.
  //
  // Since ENG-03 (#302) the fixture is one neutral `agent.message` frame, not a Claude Agent SDK
  // message: the stream carries that vocabulary itself and no screen parses an engine's shape.
  const assistantEvent = (text: string): AgentEvent => ({
    frame: 'agent.message',
    engine: 'claude-agent-sdk',
    raw: null,
    messageId: 'msg_123',
    role: 'assistant',
    blocks: [
      { type: 'reasoning', text: 'private' },
      { type: 'text', text },
    ],
  });

  it('adds the response as an agent turn and updates a repeated snapshot in place', () => {
    const speaker = { initials: 'G', name: 'General' };
    const first = assistantResponseFromAgentEvent(assistantEvent('東'));
    const complete = assistantResponseFromAgentEvent(assistantEvent('東京です。'));
    if (first === null || complete === null) throw new Error('assistant fixture was not parsed');

    const answering = withAssistantResponse(freshRun(), speaker, first);
    const answered = withAssistantResponse(answering, speaker, complete);
    expect(answered.messages).toHaveLength(2);
    expect(answered.messages[1]).toEqual({
      kind: 'agent',
      id: 'assistant-msg_123',
      speaker,
      blocks: [
        { kind: 'prose', paragraphs: [[{ text: '東京です。', strong: false, mono: false }]] },
      ],
    });
  });
});

describe('withSdkEvent and withRuntimeEvent', () => {
  it('append to their own list and leave the other alone', () => {
    const run = freshRun();
    const line = eventLineFrom('e1', '14:00:00.000', 'tool_use.Read', { file_path: '/a' });
    const withSdk = withSdkEvent(run, line);
    expect(withSdk.technical.sdkEvents).toEqual([line]);
    expect(withSdk.technical.runtimeEvents).toEqual([]);

    const withRuntime = withRuntimeEvent(run, line);
    expect(withRuntime.technical.runtimeEvents).toEqual([line]);
    expect(withRuntime.technical.sdkEvents).toEqual([]);
  });

  it('appends rather than replaces, across repeated calls', () => {
    const line = (id: string) => eventLineFrom(id, '14:00:00.000', 'system.init', 'ok');
    const run = withSdkEvent(withSdkEvent(freshRun(), line('e1')), line('e2'));
    expect(run.technical.sdkEvents.map((e) => e.id)).toEqual(['e1', 'e2']);
  });
});

describe('eventLineFrom', () => {
  it('shows a string payload as itself', () => {
    expect(eventLineFrom('e1', 't', 'assistant.text', 'hello')).toEqual({
      id: 'e1',
      time: 't',
      event: 'assistant.text',
      detail: 'hello',
    });
  });

  it('shows a non-string payload as its JSON', () => {
    const line = eventLineFrom('e1', 't', 'tool_use.Read', { file_path: '/a', n: 3 });
    expect(line.detail).toBe('{"file_path":"/a","n":3}');
  });

  it('never throws on a payload that cannot serialise', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => eventLineFrom('e1', 't', 'weird', cyclic)).not.toThrow();
  });
});

describe('formatEventTime', () => {
  it('renders HH:MM:SS.mmm, zero-padded, matching the mockup shape', () => {
    expect(formatEventTime(new Date(2026, 0, 1, 4, 2, 9, 5))).toBe('04:02:09.005');
    expect(formatEventTime(new Date(2026, 0, 1, 14, 32, 4, 118))).toBe('14:32:04.118');
  });
});

describe('badgeForRunStatus — total over the five statuses this platform defines', () => {
  it('maps every real status to a distinct label and tone', () => {
    expect(badgeForRunStatus('queued')).toEqual({ label: 'Queued', tone: 'muted', dot: true });
    expect(badgeForRunStatus('running')).toEqual({ label: 'Running', tone: 'info', dot: true });
    expect(badgeForRunStatus('completed')).toEqual({ label: 'Completed', tone: 'ok', dot: false });
    expect(badgeForRunStatus('failed')).toEqual({ label: 'Failed', tone: 'danger', dot: false });
    expect(badgeForRunStatus('cancelled')).toEqual({
      label: 'Cancelled',
      tone: 'warn',
      dot: false,
    });
  });

  it('shows an unrecognised status in its own words rather than hiding or crashing', () => {
    expect(badgeForRunStatus('exploded')).toEqual({ label: 'exploded', tone: 'muted', dot: false });
    expect(badgeForRunStatus(42)).toEqual({ label: 'Unknown', tone: 'muted', dot: false });
    expect(badgeForRunStatus(undefined)).toEqual({ label: 'Unknown', tone: 'muted', dot: false });
  });
});

describe('failureBadge', () => {
  it('reads cancellation as a deliberate stop, not a failure', () => {
    expect(failureBadge('cancelled')).toEqual({ label: 'Cancelled', tone: 'warn', dot: false });
  });

  it('names the real status when one is known, and says just "Failed" for "unknown"', () => {
    expect(failureBadge('failed')).toEqual({
      label: 'Failed · failed',
      tone: 'danger',
      dot: false,
    });
    expect(failureBadge('unknown')).toEqual({ label: 'Failed', tone: 'danger', dot: false });
  });
});

describe("parseRunFailedPayload — server/runs/sse.ts's `{ status, message }`", () => {
  it('reads a well-formed payload', () => {
    expect(parseRunFailedPayload({ status: 'failed', message: 'Not logged in.' })).toEqual({
      status: 'failed',
      message: 'Not logged in.',
    });
  });

  it('names the gap rather than throwing, for anything else', () => {
    expect(parseRunFailedPayload(null)).toEqual({
      status: 'unknown',
      message: 'the run-failed frame carried no readable payload.',
    });
    expect(parseRunFailedPayload('oops').status).toBe('unknown');
    // An object that parses but carries neither field: each falls back on its own default rather
    // than the two defaults leaking into each other.
    expect(parseRunFailedPayload({}).status).toBe('unknown');
    expect(parseRunFailedPayload({}).message).toContain('did not succeed');
  });
});

describe("parseRunStatusPayload — server/runs/launcher.ts's `{ status, error }`", () => {
  it('reads a well-formed payload, error and all', () => {
    expect(parseRunStatusPayload({ status: 'running', error: null })).toEqual({
      status: 'running',
      error: null,
    });
    expect(parseRunStatusPayload({ status: 'failed', error: 'boom' })).toEqual({
      status: 'failed',
      error: 'boom',
    });
  });

  it('never throws on a malformed payload', () => {
    expect(parseRunStatusPayload(null)).toEqual({ status: undefined, error: null });
    expect(parseRunStatusPayload(3)).toEqual({ status: undefined, error: null });
  });
});
