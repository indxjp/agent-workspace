/**
 * The neutral `agent.*` frame contract (ENG-03, #302).
 *
 * One frame of every declared kind, with three properties asserted per frame: it parses, an unknown
 * key is rejected, and the fields the vocabulary promises are actually required. The frames are
 * built from a shared base so that adding a frame to `AGENT_FRAME_NAMES` without adding it here
 * fails the first test rather than going untested.
 */
import { describe, expect, it } from 'vitest';

import { ENGINE_IDS } from './engines.js';
import {
  AGENT_FRAME_NAMES,
  AGENT_FRAME_RAW_MAX_BYTES,
  AGENT_STOP_REASONS,
  AGENT_TOOL_KINDS,
  AgentFrameRawTruncationSchema,
  AgentFrameSchema,
  RELAYED_EVENT_NAMES,
  isAgentFrameName,
  isAgentFrameRawTruncated,
  isLegacyRelayedEventName,
} from './run-events.js';

const ENGINE = ENGINE_IDS[0];
const base = { engine: ENGINE, raw: { type: 'assistant' } } as const;

const FRAMES: Readonly<Record<string, Record<string, unknown>>> = {
  'agent.session': { frame: 'agent.session', ...base, engineSessionId: 'sess_1', model: null },
  'agent.message': {
    frame: 'agent.message',
    ...base,
    messageId: 'msg_1',
    role: 'assistant',
    blocks: [
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'hello' },
    ],
  },
  'agent.message.delta': {
    frame: 'agent.message.delta',
    ...base,
    messageId: 'msg_1',
    block: 'text',
    text: 'he',
  },
  'agent.tool.call': {
    frame: 'agent.tool.call',
    ...base,
    toolCallId: 'tool_1',
    name: 'Read',
    kind: 'read',
    input: { path: '/x' },
  },
  'agent.tool.result': {
    frame: 'agent.tool.result',
    ...base,
    toolCallId: 'tool_1',
    status: 'completed',
    output: 'contents',
    isError: false,
  },
  'agent.usage': {
    frame: 'agent.usage',
    ...base,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: 3,
    reasoningTokens: null,
  },
  'agent.result': {
    frame: 'agent.result',
    ...base,
    stopReason: 'end_turn',
    turns: 2,
    engineCostUsd: 0.004,
  },
  'agent.native': {
    frame: 'agent.native',
    ...base,
    type: 'system/status',
    payload: { type: 'system' },
  },
  'agent.malformed': { frame: 'agent.malformed', ...base, reason: 'not an object' },
};

describe('the neutral agent frame vocabulary', () => {
  it('covers every declared frame name, and nothing else', () => {
    expect(Object.keys(FRAMES)).toEqual([...AGENT_FRAME_NAMES]);
    for (const name of AGENT_FRAME_NAMES) expect(isAgentFrameName(name)).toBe(true);
    for (const name of RELAYED_EVENT_NAMES) expect(isAgentFrameName(name)).toBe(false);
    // The two vocabularies are disjoint, which is what lets the event-read path tell a row it must
    // upgrade from a row that is already neutral by its name alone.
    for (const name of AGENT_FRAME_NAMES) expect(isLegacyRelayedEventName(name)).toBe(false);
    for (const name of RELAYED_EVENT_NAMES) expect(isLegacyRelayedEventName(name)).toBe(true);
  });

  it.each(AGENT_FRAME_NAMES)('%s parses, and rejects an unknown key', (name) => {
    const frame = FRAMES[name] ?? {};
    const parsed = AgentFrameSchema.safeParse(frame);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(AgentFrameSchema.safeParse({ ...frame, surprise: 1 }).success).toBe(false);
    // A frame must name a registered engine: the point of the field is that a consumer never has to
    // ask which engine produced an event, and a string nothing registers would not answer that.
    expect(AgentFrameSchema.safeParse({ ...frame, engine: 'not-an-engine' }).success).toBe(false);
    const withoutRaw = { ...frame };
    delete withoutRaw['raw'];
    expect(AgentFrameSchema.safeParse(withoutRaw).success).toBe(false);
  });

  it('refuses a frame name it does not know, rather than passing it through', () => {
    expect(AgentFrameSchema.safeParse({ frame: 'agent.mystery', ...base }).success).toBe(false);
    expect(AgentFrameSchema.safeParse({ ...base }).success).toBe(false);
  });

  it('keeps `raw` opaque: any JSON value is carried, including null', () => {
    for (const raw of [null, 0, 'text', [], { a: 1 }]) {
      expect(AgentFrameSchema.safeParse({ ...FRAMES['agent.malformed'], raw }).success).toBe(true);
    }
  });

  it('holds the closed tool-kind and stop-reason sets the frames are written in', () => {
    const call = FRAMES['agent.tool.call'] ?? {};
    for (const kind of AGENT_TOOL_KINDS) {
      expect(AgentFrameSchema.safeParse({ ...call, kind }).success).toBe(true);
    }
    expect(AgentFrameSchema.safeParse({ ...call, kind: 'summon' }).success).toBe(false);
    const result = FRAMES['agent.result'] ?? {};
    for (const stopReason of AGENT_STOP_REASONS) {
      expect(AgentFrameSchema.safeParse({ ...result, stopReason }).success).toBe(true);
    }
    expect(AgentFrameSchema.safeParse({ ...result, stopReason: 'gave_up' }).success).toBe(false);
  });

  it('refuses a counter that is not a non-negative integer, and admits an unreported one', () => {
    const usage = FRAMES['agent.usage'] ?? {};
    expect(AgentFrameSchema.safeParse({ ...usage, inputTokens: -1 }).success).toBe(false);
    expect(AgentFrameSchema.safeParse({ ...usage, inputTokens: 1.5 }).success).toBe(false);
    // An engine that reported nothing is not an engine that reported zero, so the counters an
    // engine may omit are nullable and the two it must report are not.
    expect(AgentFrameSchema.safeParse({ ...usage, reasoningTokens: null }).success).toBe(true);
    expect(AgentFrameSchema.safeParse({ ...usage, inputTokens: null }).success).toBe(false);
  });

  it('recognises the raw truncation marker, and only the whole marker', () => {
    const marker = {
      truncated: true,
      encodedBytes: AGENT_FRAME_RAW_MAX_BYTES + 1,
      limitBytes: AGENT_FRAME_RAW_MAX_BYTES,
    };
    expect(AgentFrameRawTruncationSchema.safeParse(marker).success).toBe(true);
    expect(isAgentFrameRawTruncated(marker)).toBe(true);
    expect(isAgentFrameRawTruncated({ ...marker, encodedBytes: null })).toBe(true);
    // A payload of the engine's own that happens to carry a `truncated` key is not this marker.
    expect(isAgentFrameRawTruncated({ truncated: true })).toBe(false);
    expect(isAgentFrameRawTruncated({ ...marker, truncated: false })).toBe(false);
    expect(isAgentFrameRawTruncated('truncated')).toBe(false);
    // A truncated payload is still a valid frame: the cap truncates, it never rejects.
    expect(AgentFrameSchema.safeParse({ ...FRAMES['agent.message'], raw: marker }).success).toBe(
      true,
    );
  });
});
