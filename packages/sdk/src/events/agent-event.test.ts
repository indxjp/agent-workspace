/**
 * The SDK's `agent.*` parser (ENG-03, #302).
 *
 * Two things are checked, and the second is the one that used to be impossible: that every frame of
 * the neutral vocabulary parses into a typed event, and that a frame which does **not** satisfy its
 * contract is a `ContractViolationError` rather than a partially-read object. The SDK no longer maps
 * one engine's classification, so there is nothing here about `tool_use`, `modelUsage` or a session
 * id field name — that vocabulary lives behind the runner's adapter.
 */
import { ENGINE_IDS } from '@indx-workspace/contracts/engines';
import { AGENT_FRAME_NAMES } from '@indx-workspace/contracts/run-events';
import { describe, expect, it } from 'vitest';

import { ContractViolationError } from '../errors.js';
import { assistantResponseFromAgentEvent, toAgentEvent, type AgentEvent } from './agent-event.js';
import type { RunEventFrame } from './run-events.js';

const ENGINE = ENGINE_IDS[0];

function relayed(name: string, data: unknown): RunEventFrame {
  return { kind: 'runtime', id: '7', name, data };
}

function frame(name: string, fields: Record<string, unknown>): RunEventFrame {
  return relayed(name, { frame: name, engine: ENGINE, raw: { type: 'assistant' }, ...fields });
}

const FRAMES: Readonly<Record<string, Record<string, unknown>>> = {
  'agent.session': { engineSessionId: 'sess_1', model: 'claude-opus-5' },
  'agent.message': {
    messageId: 'msg_1',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'hello' }],
  },
  'agent.message.delta': { messageId: 'msg_1', block: 'text', text: 'he' },
  'agent.tool.call': { toolCallId: 't1', name: 'Read', kind: 'read', input: { path: '/x' } },
  'agent.tool.result': {
    toolCallId: 't1',
    status: 'completed',
    output: 'contents',
    isError: false,
  },
  'agent.usage': {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
    reasoningTokens: null,
  },
  'agent.result': { stopReason: 'end_turn', turns: 1, engineCostUsd: null },
  'agent.native': { type: 'system/status', payload: { type: 'system' } },
  'agent.malformed': { reason: 'not an object' },
};

describe('toAgentEvent', () => {
  it.each(AGENT_FRAME_NAMES)('parses %s into a typed event carrying engine and raw', (name) => {
    const event = toAgentEvent(frame(name, FRAMES[name] ?? {}));
    expect(event).not.toBeNull();
    expect(event?.frame).toBe(name);
    expect(event?.engine).toBe(ENGINE);
    expect(event?.raw).toEqual({ type: 'assistant' });
  });

  it('answers null for the platform’s own frames, which are not agent events', () => {
    const platform: readonly RunEventFrame[] = [
      { kind: 'done' },
      { kind: 'run-status', id: '1', data: { status: 'running', error: null } },
      { kind: 'run-failed', data: { status: 'failed', message: 'x' } },
      { kind: 'stream-reset', data: { reason: 'retention', resumedAfter: null } },
    ];
    for (const item of platform) expect(toAgentEvent(item)).toBeNull();
  });

  it('refuses a payload that does not satisfy its frame contract', () => {
    // A missing required field, an unknown key, and an engine nothing registers: each is drift in
    // something the platform wrote, so each is named rather than read around.
    expect(() => toAgentEvent(frame('agent.session', {}))).toThrow(ContractViolationError);
    expect(() =>
      toAgentEvent(frame('agent.result', { ...FRAMES['agent.result'], surprise: true })),
    ).toThrow(ContractViolationError);
    expect(() =>
      toAgentEvent(
        relayed('agent.malformed', { frame: 'agent.malformed', engine: 'pi', raw: null }),
      ),
    ).toThrow(ContractViolationError);
    expect(() => toAgentEvent(relayed('agent.message', null))).toThrow(ContractViolationError);
  });

  it('refuses a frame name this build does not know', () => {
    expect(() => toAgentEvent(relayed('agent.telepathy', { frame: 'agent.telepathy' }))).toThrow(
      ContractViolationError,
    );
    // The legacy vocabulary is upgraded by the server on read, so a client meeting one is talking
    // to a control plane older than itself and is told so rather than shown a blank transcript.
    expect(() => toAgentEvent(relayed('sdk-event', { kind: 'event' }))).toThrow(
      ContractViolationError,
    );
  });

  it('refuses a frame whose name and payload disagree', () => {
    expect(() =>
      toAgentEvent(
        relayed('agent.result', {
          frame: 'agent.malformed',
          engine: ENGINE,
          raw: null,
          reason: 'x',
        }),
      ),
    ).toThrow(/payload says agent.malformed/);
  });

  it('names the failing operation and the issues, so a caller can log which frame broke', () => {
    try {
      toAgentEvent(frame('agent.usage', { inputTokens: -1 }));
      expect.unreachable('the parser accepted a negative token count');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractViolationError);
      const violation = error as ContractViolationError;
      expect(violation.message).toContain('runs.events(agent.usage)');
      expect(violation.issues.join(' ')).toContain('inputTokens');
    }
  });
});

describe('assistantResponseFromAgentEvent', () => {
  const message = (fields: Record<string, unknown>): AgentEvent => {
    const event = toAgentEvent(frame('agent.message', { ...FRAMES['agent.message'], ...fields }));
    if (event === null) throw new Error('the fixture did not parse');
    return event;
  };

  it('reads the assistant’s visible text, in order', () => {
    const event = message({
      blocks: [
        { type: 'reasoning', text: 'private' },
        { type: 'text', text: 'Tokyo.' },
        { type: 'text', text: 'It is warm.' },
      ],
    });
    expect(assistantResponseFromAgentEvent(event)).toEqual({
      id: 'msg_1',
      text: ['Tokyo.', 'It is warm.'],
    });
  });

  it('keeps everything but a spoken assistant turn out of the conversation', () => {
    // A user turn, a turn with no id to replace a snapshot by, a turn whose only text is blank, and
    // a frame that is not a message at all: none of these is the assistant answering.
    expect(assistantResponseFromAgentEvent(message({ role: 'user' }))).toBeNull();
    expect(assistantResponseFromAgentEvent(message({ messageId: null }))).toBeNull();
    expect(
      assistantResponseFromAgentEvent(message({ blocks: [{ type: 'text', text: '   ' }] })),
    ).toBeNull();
    expect(
      assistantResponseFromAgentEvent(
        message({ blocks: [{ type: 'reasoning', text: 'thinking' }] }),
      ),
    ).toBeNull();
    for (const name of ['agent.result', 'agent.tool.call', 'agent.native'] as const) {
      const event = toAgentEvent(frame(name, FRAMES[name] ?? {}));
      expect(event === null ? null : assistantResponseFromAgentEvent(event)).toBeNull();
    }
  });
});

describe('the SDK event surface holds no engine vocabulary', () => {
  it('reads nothing off an engine-shaped message, because the stream is already neutral', () => {
    // The acceptance criterion of #302, as a test: a Claude Agent SDK message relayed under a
    // neutral name is not a frame this parser can read, and it says so instead of half-reading it.
    expect(() =>
      toAgentEvent(
        relayed('agent.message', {
          type: 'assistant',
          message: { id: 'msg_1', content: [{ type: 'text', text: 'hi' }] },
        }),
      ),
    ).toThrow(ContractViolationError);
  });
});
