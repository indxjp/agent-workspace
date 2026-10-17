/**
 * The `agent-frames` vectors, replayed against the **SDK's parser** (ENG-03, #302).
 *
 * This suite imports the packages through their published exports, so decision D-012 puts it here
 * rather than beside an application. What it holds is the half of the codec the SDK owns: a frame the
 * server encoded parses back to exactly that frame, and a payload that is not one is refused by name
 * instead of half-read.
 */
import { AGENT_FRAME_NAMES } from '@indx-workspace/contracts/run-events';
import { ContractViolationError } from '@indx-workspace/sdk';
import { toAgentEvent, assistantResponseFromAgentEvent } from '@indx-workspace/sdk/events';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from './vectors.js';

const FAMILY = 'agent-frames';

/** The vocabulary the SDK publishes is the vocabulary the model names, in the model's order. */
describe('the vocabulary the SDK parses', () => {
  it('is the closed set the model names', () => {
    const names = loadVectors(FAMILY, 'vocabulary.json').find((v) => v.id === 'names');
    if (names === undefined) throw new Error('no names vector');
    expect([...AGENT_FRAME_NAMES]).toEqual(asRecord(names.expected, names.id)['frames']);
  });
});

describe('the SDK parses the frames the server encodes', () => {
  it.each(
    loadVectors(FAMILY, 'parser.json')
      // The other vectors in the file are the chat-message ones, replayed below.
      .filter((v) => v.id.startsWith('ok/') || v.id.startsWith('refused/'))
      .map((v) => [v.id, v] as const),
  )('replays %s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const frame = {
      kind: 'runtime' as const,
      id: '1',
      name: asString(input['name'], 'name'),
      data: input['data'],
    };
    if (expected['accepted'] === true) {
      const event = toAgentEvent(frame);
      expect(event).not.toBeNull();
      expect(event?.frame).toBe(expected['frame']);
      expect(event?.engine).toBe(expected['engine']);
      // The whole payload, not a subset: the parser's output is the frame, so a field it silently
      // dropped would show up as an inequality here.
      expect(event).toEqual(input['data']);
      return;
    }
    // Refused, and refused by name. A `ContractViolationError` is what a client branches on to
    // tell platform drift from a dropped connection.
    expect(() => toAgentEvent(frame)).toThrow(ContractViolationError);
  });

  it('answers nothing for the platform’s own frames, which are not agent events', () => {
    expect(toAgentEvent({ kind: 'done' })).toBeNull();
    expect(
      toAgentEvent({ kind: 'run-status', id: '1', data: { status: 'running', error: null } }),
    ).toBeNull();
    expect(
      toAgentEvent({ kind: 'run-failed', data: { status: 'failed', message: 'x' } }),
    ).toBeNull();
    expect(
      toAgentEvent({ kind: 'stream-reset', data: { reason: 'retention', resumedAfter: null } }),
    ).toBeNull();
  });
});

describe('only a spoken assistant turn becomes a chat message', () => {
  it.each(
    loadVectors(FAMILY, 'parser.json')
      .filter((v) => !v.id.startsWith('ok/') && !v.id.startsWith('refused/'))
      .map((v) => [v.id, v] as const),
  )('replays %s', (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const event = toAgentEvent({
      kind: 'runtime',
      id: '1',
      name: asString(input['name'], 'name'),
      data: input['data'],
    });
    if (event === null) throw new Error(`${vector.id}: the fixture did not parse`);
    const response = assistantResponseFromAgentEvent(event);
    if (vector.expected === null) {
      expect(response).toBeNull();
      return;
    }
    const expected = asRecord(vector.expected, vector.id);
    expect(response).toEqual({ id: expected['id'], text: expected['text'] });
  });
});
