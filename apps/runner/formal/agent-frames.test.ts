/**
 * The `agent-frames` vectors, replayed against the mapping the **runner** streams (ENG-03, #302).
 *
 * Decision D-012: a suite that imports application code lives with the application. This one drives
 * `@agent-workspace/core`'s `toAgentFrames` — the Claude adapter's mapping, which
 * `apps/runner/src/server.ts` calls on every event and which ENG-04 moves into
 * `packages/engine-claude-agent-sdk` — and compares it to what `formal/Vectors/AgentFrames.lean`
 * says it must produce. A disagreement is a failing test, and the fix is never to edit a vector
 * (docs/formal/00-orchestrator-prompt.md §10).
 *
 * The vocabulary is compared against the runner's own copy of it (`packages/core`'s
 * `agentFrameNames`); `apps/web/server/sdk-conformance.test.ts` is where that copy is held to
 * `packages/contracts`' published one.
 */
import {
  AGENT_FRAME_RAW_MAX_BYTES,
  agentFrameNames,
  agentStopReasons,
  agentToolKinds,
  capAgentFrameRaw,
  claudeToolKind,
  classifySdkEvent,
  toAgentFrames,
} from '@agent-workspace/core';
import { describe, expect, it } from 'vitest';

import { asRecord, loadVectors } from '../../../tests/formal/vectors.js';

const FAMILY = 'agent-frames';

function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error(`${label}: expected an array of strings, got ${JSON.stringify(value)}`);
  }
  return value;
}

function vector(file: string, id: string): Record<string, unknown> {
  const found = loadVectors(FAMILY, file).find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`${file}: no vector ${id}`);
  return asRecord(found.expected, id);
}

describe('the neutral vocabulary the runner streams', () => {
  it('is the closed set, the closed kinds and the closed stop reasons the model names', () => {
    const names = vector('vocabulary.json', 'names');
    expect([...agentFrameNames]).toEqual(names['frames']);
    expect([...agentToolKinds]).toEqual(names['toolKinds']);
    expect([...agentStopReasons]).toEqual(names['stopReasons']);
    expect(AGENT_FRAME_RAW_MAX_BYTES).toBe(names['rawMaxBytes']);
  });

  it('shares no name with the vocabulary this stream carried before ENG-03', () => {
    const disjoint = vector('vocabulary.json', 'disjoint-from-legacy');
    const legacy = strings(disjoint['legacy'], 'legacy');
    expect(agentFrameNames.filter((name) => legacy.includes(name))).toEqual(disjoint['overlap']);
  });

  it('gives each Claude tool the ACP kind the model gives it', () => {
    const found = loadVectors(FAMILY, 'vocabulary.json').find((v) => v.id === 'tool-kinds');
    if (found === undefined) throw new Error('no tool-kinds vector');
    expect(strings(found.input, 'tool names').map(claudeToolKind)).toEqual(found.expected);
  });

  it('truncates an oversized `raw` with the marker, and never rejects it', () => {
    const expected = vector('vocabulary.json', 'raw-cap');
    const under = 'x'.repeat(8);
    expect(capAgentFrameRaw(under)).toBe(under);
    // The vector is one byte over the cap *as encoded*: `JSON.stringify` adds the two quotes.
    const over = 'x'.repeat(AGENT_FRAME_RAW_MAX_BYTES - 1);
    expect(capAgentFrameRaw(over)).toEqual(expected['over']);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(capAgentFrameRaw(cyclic)).toEqual(expected['unserialisable']);
  });
});

describe('the Claude mapping, message by message', () => {
  it.each(loadVectors(FAMILY, 'mapping.json').map((v) => [v.id, v] as const))(
    'replays %s',
    (_id, item) => {
      const expected = asRecord(item.expected, item.id);
      // A pairing vector carries two messages; a mapping vector carries one.
      const messages: readonly unknown[] = Array.isArray(item.input) ? item.input : [item.input];
      const frames = messages.flatMap((message) => [...toAgentFrames(classifySdkEvent(message))]);
      expect(frames.map((frame) => frame.frame)).toEqual(expected['names']);
      // Never dropped: the model's own list is non-empty for every engine message, so an empty
      // result here would fail on the line above rather than pass quietly.
      expect(frames.length).toBeGreaterThan(0);
      if (expected['frames'] !== undefined) {
        // Whole frames, `raw` and `agent.malformed`'s reason included: the model states the code's
        // full diagnostic, so nothing here is compared up to a prefix.
        expect(frames).toEqual(expected['frames']);
      }
      if (expected['callIds'] !== undefined) {
        expect(
          frames.flatMap((frame) => (frame.frame === 'agent.tool.call' ? [frame.toolCallId] : [])),
        ).toEqual(expected['callIds']);
        expect(
          frames.flatMap((frame) =>
            frame.frame === 'agent.tool.result' ? [frame.toolCallId] : [],
          ),
        ).toEqual(expected['resultIds']);
      }
      if (expected['paired'] !== undefined) {
        const announced = new Set<string>();
        let paired = true;
        for (const frame of frames) {
          if (frame.frame === 'agent.tool.call') announced.add(frame.toolCallId);
          if (frame.frame === 'agent.tool.result' && !announced.has(frame.toolCallId)) {
            paired = false;
          }
        }
        expect(paired).toBe(expected['paired']);
      }
    },
  );
});
