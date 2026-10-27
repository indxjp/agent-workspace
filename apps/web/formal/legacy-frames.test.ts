/**
 * The `agent-frames` vectors, replayed against the **event-read path** (ENG-03, #302).
 *
 * Decision D-012: a suite that imports application code lives with the application. This one drives
 * `apps/web/server/runs/agent-frames.ts` — the upgrade a pre-ENG-03 `run_events` row goes through on
 * its way to the wire — and the `(sequence, sub-index)` ids and resume that go with it.
 *
 * The refinement it exists to hold is the T4 one: a legacy run and a fresh run of the same engine
 * messages yield the same frames. Both sides are computed, here and in the model, rather than
 * written out — so an upgrade that started to drift would fail rather than agree with a stale
 * expectation.
 */
import { classifySdkEvent, toAgentFrames } from '@agent-workspace/run-protocol';
import { describe, expect, it } from 'vitest';

import { upgradeEventStream, upgradeStoredEvent, wireEventId } from '../server/runs/agent-frames';
import { readResumeCursor } from '../server/runs/cursor';
import type { SseEvent, SseWireEvent } from '../server/runs/sse';
import { asRecord, loadVectors } from '../../../tests/formal/vectors';

const FAMILY = 'agent-frames';

function stream(...events: readonly SseEvent[]): AsyncIterable<SseEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        // A real store's stream awaits the database; awaiting here keeps the shape the upgrade
        // generator is driven with in a test the same as the one it meets in production.
        yield await Promise.resolve(event);
      }
    },
  };
}

async function collect(
  source: AsyncIterable<SseEvent>,
  resumedWithin: { readonly sequence: bigint; readonly subIndex: number } | null,
): Promise<readonly SseWireEvent[]> {
  const out: SseWireEvent[] = [];
  for await (const event of upgradeEventStream(source, resumedWithin)) out.push(event);
  return out;
}

describe('pre-ENG-03 rows, upgraded on read', () => {
  it.each(loadVectors(FAMILY, 'legacy.json').map((v) => [v.id, v] as const))(
    'replays %s',
    (_id, vector) => {
      const input = asRecord(vector.input, vector.id);
      const expected = asRecord(vector.expected, vector.id);
      const row: SseEvent = {
        id: 5n,
        type: String(input['type']),
        data: input['data'],
      };
      const served = upgradeStoredEvent(row);
      expect(served.map((event) => event.type)).toEqual(expected['names']);
      // Every upgraded frame is served under a sub-index of the row's own sequence.
      expect(served.map((event) => String(event.id))).toEqual(
        served.map((_event, index) => wireEventId(5n, index)),
      );
      if (expected['frames'] !== undefined) {
        // Whole frames, `raw` and every `agent.malformed` reason included.
        expect(served.map((event) => event.data)).toEqual(expected['frames']);
      }
      if (expected['lastReason'] !== undefined) {
        // The over-long row: its last served frame reports the frames it stands in for, under the
        // largest id the grammar admits.
        const last = served.at(-1);
        expect(last?.data).toMatchObject({
          frame: 'agent.malformed',
          reason: expected['lastReason'],
        });
        expect(last === undefined ? null : String(last.id)).toBe(expected['lastId']);
      }
      // The refinement: the same row, and a fresh run of the message it stored, agree.
      if (expected['fresh'] !== undefined) {
        const message = asRecord(input['data'], vector.id)['event'];
        expect(served.map((event) => event.data)).toEqual([
          ...toAgentFrames(classifySdkEvent(message)),
        ]);
      }
    },
  );
});

describe('the served ids and resume', () => {
  it('serves the mixed log under strictly increasing ids in the documented grammar', async () => {
    const legacy = loadVectors(FAMILY, 'legacy.json').find((v) => v.id === 'sdk-event-assistant');
    const resume = loadVectors(FAMILY, 'resume.json').find((v) => v.id === 'mixed-log');
    if (legacy === undefined || resume === undefined) throw new Error('missing vectors');
    const row = asRecord(legacy.input, legacy.id);
    const served = await collect(
      stream(
        { id: 1n, type: 'run.status', data: { status: 'running', error: null } },
        { id: 2n, type: String(row['type']), data: row['data'] },
        {
          id: 3n,
          type: 'agent.result',
          data: toAgentFrames(
            classifySdkEvent({
              type: 'result',
              subtype: 'success',
            }),
          )[0],
        },
      ),
      null,
    );
    const expected = asRecord(resume.expected, resume.id);
    expect(served.map((event) => String(event.id))).toEqual(expected['ids']);
    expect(expected['increasing']).toBe(true);
  });

  it.each(
    loadVectors(FAMILY, 'resume.json')
      .filter((v) => v.id !== 'mixed-log' && v.id !== 'resume-one-to-one-row')
      .map((v) => [v.id, v] as const),
  )('replays %s', async (_id, vector) => {
    const legacy = loadVectors(FAMILY, 'legacy.json').find((v) => v.id === 'sdk-event-assistant');
    if (legacy === undefined) throw new Error('missing legacy vector');
    const row = asRecord(legacy.input, legacy.id);
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const sequence = BigInt(Number(input['sequence']));
    const subIndex = Number(input['subIndex']);
    // `resume-other-row` names a sequence the retained row does not have, which is the
    // post-`stream-reset` case: the oldest retained row is new to the client in its entirety.
    const rowSequence = vector.id === 'resume-other-row' ? 7n : sequence;
    const served = await collect(
      stream({ id: rowSequence, type: String(row['type']), data: row['data'] }),
      { sequence, subIndex },
    );
    expect(served.map((event) => event.type)).toEqual(expected['tail']);
    if (expected['whole'] !== undefined) {
      const whole = await collect(
        stream({ id: rowSequence, type: String(row['type']), data: row['data'] }),
        null,
      );
      // Neither lost nor repeated: what the client had, plus what it is served back, is the row.
      expect([
        ...whole.slice(0, subIndex + 1).map((event) => event.type),
        ...served.map((event) => event.type),
      ]).toEqual(expected['whole']);
    }
  });

  it('serves a one-to-one row whole to a sub-indexed cursor that names it', async () => {
    const vector = loadVectors(FAMILY, 'resume.json').find((v) => v.id === 'resume-one-to-one-row');
    if (vector === undefined) throw new Error('missing resume vector');
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);
    const sequence = BigInt(Number(input['sequence']));
    // A row a post-ENG-03 run wrote: served under its bare sequence, one frame per row.
    const row: SseEvent = {
      id: sequence,
      type: 'agent.result',
      data: toAgentFrames(classifySdkEvent({ type: 'result', subtype: 'success' }))[0],
    };
    const served = await collect(stream(row), {
      sequence,
      subIndex: Number(input['subIndex']),
    });
    expect(served.map((event) => event.type)).toEqual(expected['tail']);
    expect(served.map((event) => String(event.id))).toEqual([String(sequence)]);
  });

  it('reads a sub-indexed cursor back off the wire, so resume can name any frame', () => {
    const resume = loadVectors(FAMILY, 'resume.json').find((v) => v.id === 'mixed-log');
    if (resume === undefined) throw new Error('missing resume vector');
    for (const id of asRecord(resume.expected, resume.id)['ids'] as readonly string[]) {
      const cursor = readResumeCursor(id, null);
      expect(cursor.kind, id).toBe('after');
      if (cursor.kind !== 'after') continue;
      const [sequence, sub] = id.split('.');
      expect(cursor.id).toBe(BigInt(sequence ?? '0'));
      expect(cursor.subIndex).toBe(sub === undefined ? null : Number(sub));
    }
  });
});
