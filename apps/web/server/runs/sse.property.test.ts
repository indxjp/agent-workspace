/**
 * Property test for the run event wire format (F-21 property 3): every frame this server writes is
 * read back by the SDK's parser as exactly what was written. The event names and control frames are
 * drawn from the published contract (`@indx-workspace/contracts/run-events`), so a name the
 * contract admits and the encoder or the parser mishandles fails here. On a failure fast-check
 * prints the seed and path that reproduce it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CONTROL_FRAME_NAMES,
  EVENT_NAME_PATTERN,
  RELAYED_EVENT_NAMES,
  RUN_STATUS_EVENT,
} from '@indx-workspace/contracts/run-events';
import { parseSseFrame, readSseFrames, type SseFrame } from '@indx-workspace/sdk/events';

import { readResumeCursor } from './cursor';
import {
  classifyStoredEventName,
  MAX_EVENT_ID,
  sseControlFrame,
  sseFrame,
  type SseWireEvent,
} from './sse';

const eventName = fc
  .oneof(
    fc.constantFrom(RUN_STATUS_EVENT, ...RELAYED_EVENT_NAMES),
    fc.stringMatching(EVENT_NAME_PATTERN),
  )
  .filter((name) => classifyStoredEventName(name).kind === 'ok');

const sequence = fc.bigInt({ min: 0n, max: MAX_EVENT_ID });

/** A bare sequence, or `<sequence>.<sub-index>` — the two id shapes `sse.ts` documents. */
const wireId = fc.oneof(
  sequence,
  fc.tuple(sequence, fc.integer({ min: 0, max: 999 })).map(([id, sub]) => `${id}.${sub}`),
);

const at = fc.date({
  min: new Date('1970-01-01T00:00:00Z'),
  max: new Date('9999-12-31T23:59:59Z'),
  noInvalidDate: true,
});

/** `at` is optional: a frame without it has no `at:` field. */
const wireEvent: fc.Arbitrary<SseWireEvent> = fc.record(
  { id: wireId, type: eventName, data: fc.jsonValue(), at },
  { requiredKeys: ['id', 'type', 'data'] },
);

/** The value `JSON.parse` gives back for `data`; `-0` and `0` are one JSON number. */
function viaJson(data: unknown): unknown {
  return JSON.parse(JSON.stringify(data)) as unknown;
}

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe('sseFrame ∘ parseSseFrame (property)', () => {
  it('reads every durable frame back as its name, id, timestamp and data', () => {
    fc.assert(
      fc.property(wireEvent, (event) => {
        const frame = sseFrame(event);
        expect(frame.endsWith('\n\n')).toBe(true);
        const id = String(event.id);
        expect(parseSseFrame(frame.slice(0, -2))).toEqual({
          event: event.type,
          id,
          ...(event.at === undefined ? {} : { at: event.at.toISOString() }),
          data: viaJson(event.data),
        });
        // The id the client echoes as `Last-Event-ID` resumes after the same frame.
        const cursor = readResumeCursor(id, null);
        const [sequenceText, subText] = id.split('.');
        expect(cursor).toEqual({
          kind: 'after',
          id: BigInt(sequenceText ?? ''),
          subIndex: subText === undefined ? null : Number(subText),
          source: 'header',
        });
      }),
      { numRuns: 300 },
    );
  });

  it('reads every control frame back with its name, no id and its data', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CONTROL_FRAME_NAMES), fc.jsonValue(), (name, data) => {
        const frame = sseControlFrame({ name, data });
        expect(parseSseFrame(frame.slice(0, -2))).toEqual({
          event: name,
          id: null,
          data: viaJson(data),
        });
      }),
      { numRuns: 100 },
    );
  });

  it('reads a concatenated stream back as the same sequence of frames', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(wireEvent, { maxLength: 8 }), async (events) => {
        const read: SseFrame[] = [];
        for await (const frame of readSseFrames(stream(events.map(sseFrame).join('')))) {
          read.push(frame);
        }
        expect(read.map((frame) => [frame.event, frame.id, frame.data])).toEqual(
          events.map((event) => [event.type, String(event.id), viaJson(event.data)]),
        );
      }),
      { numRuns: 100 },
    );
  });
});
