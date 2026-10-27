import {
  CONTROL_FRAME_NAMES,
  EVENT_NAME_PATTERN,
  RELAYED_EVENT_NAMES,
  PLATFORM_EVENT_NAMES,
  RUN_STATUS_EVENT,
  RUN_WARNING_EVENT,
  RelayedEventDataSchema,
  RunFailedFrameDataSchema,
  RunStatusEventDataSchema,
  RunWarningEventDataSchema,
  StreamResetFrameDataSchema,
} from '@indx-workspace/contracts/run-events';
import {
  classifyRunEventFrame,
  parseSseFrame,
  readSseFrames,
  splitSseFrames,
} from '@indx-workspace/sdk/events';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from './vectors.js';

const FAMILY = 'events-sse';

function strings(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((x): x is string => typeof x === 'string')) {
    throw new Error(`${name}: expected string array`);
  }
  return value;
}

describe('Lean run-event contract vectors', () => {
  it('pins every contract name and its grammar', () => {
    const vectors = loadVectors(FAMILY, 'vocabulary.json');
    const names = asRecord(vectors[0]?.expected, 'names');
    expect(CONTROL_FRAME_NAMES).toEqual(names['control']);
    expect(RELAYED_EVENT_NAMES).toEqual(names['relayed']);
    expect(RUN_STATUS_EVENT).toBe(names['status']);
    expect(RUN_WARNING_EVENT).toBe(names['warning']);
    expect(PLATFORM_EVENT_NAMES).toEqual(names['platform']);
    for (const vector of loadVectors(FAMILY, 'names.json')) {
      expect(EVENT_NAME_PATTERN.test(asString(vector.input, vector.id)), vector.id).toBe(
        asRecord(vector.expected, vector.id)['pattern'],
      );
    }
  });

  it.each(loadVectors(FAMILY, 'schemas.json').map((v) => [v.id, v] as const))(
    '%s',
    (_id, vector) => {
      const input = asRecord(vector.input, vector.id);
      const schema = input['schema'];
      const actual =
        schema === 'status'
          ? RunStatusEventDataSchema.safeParse(input['body']).success
          : schema === 'warning'
            ? RunWarningEventDataSchema.safeParse(input['body']).success
            : schema === 'failed'
              ? RunFailedFrameDataSchema.safeParse(input['body']).success
              : schema === 'reset'
                ? StreamResetFrameDataSchema.safeParse(input['body']).success
                : RelayedEventDataSchema.safeParse(input['body']).success;
      expect(actual).toBe(asRecord(vector.expected, vector.id)['valid']);
    },
  );
});

describe('Lean SDK event parser vectors', () => {
  it.each(loadVectors(FAMILY, 'parser.json').map((v) => [v.id, v] as const))(
    '%s',
    (_id, vector) => {
      const actual = parseSseFrame(asString(vector.input, vector.id));
      if (vector.expected === null) {
        expect(actual).toBeNull();
        return;
      }
      const expected = asRecord(vector.expected, vector.id);
      expect(actual?.event).toBe(expected['event']);
      expect(actual?.id).toBe(expected['id']);
      const raw = expected['dataRaw'];
      if (raw === null || raw === '') expect(actual?.data).toBeNull();
      else {
        const data = asString(raw, 'dataRaw');
        let parsed: unknown;
        try {
          parsed = JSON.parse(data) as unknown;
        } catch {
          parsed = data;
        }
        expect(actual?.data).toEqual(parsed);
      }
    },
  );

  it.each(loadVectors(FAMILY, 'splitter.json').map((v) => [v.id, v] as const))(
    '%s',
    (_id, vector) => {
      const expected = asRecord(vector.expected, vector.id);
      expect(splitSseFrames(asString(vector.input, vector.id))).toEqual({
        frames: expected['frames'],
        rest: expected['rest'],
      });
    },
  );

  it('reads a frame split at every UTF-8 byte boundary', async () => {
    const sample = 'event: system\nid: 1\ndata: {"kind":"text","value":"雪"}\n\n';
    const bytes = new TextEncoder().encode(sample);
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, cut));
          controller.enqueue(bytes.slice(cut));
          controller.close();
        },
      });
      const frames = [];
      for await (const frame of readSseFrames(stream)) frames.push(frame);
      expect(frames, `byte ${String(cut)}`).toEqual([
        { event: 'system', id: '1', data: { kind: 'text', value: '雪' } },
      ]);
    }
  });

  it('classifies the durable frame and refuses malformed platform data', () => {
    const frame = parseSseFrame(
      'event: run.status\nid: 7\ndata: {"status":"running","error":null}',
    );
    if (frame === null) throw new Error('the named frame was discarded');
    expect(classifyRunEventFrame(frame)).toEqual({
      kind: 'run-status',
      id: '7',
      data: { status: 'running', error: null },
    });
    expect(() => classifyRunEventFrame({ event: 'run.status', id: '8', data: {} })).toThrow();
  });

  it('covers every relayed event name in the declared vocabulary', () => {
    const relayed = strings(RELAYED_EVENT_NAMES, 'RELAYED_EVENT_NAMES');
    for (const name of relayed) {
      expect(classifyRunEventFrame({ event: name, id: '1', data: { kind: name } })).toEqual({
        kind: 'runtime',
        id: '1',
        name,
        data: { kind: name },
      });
    }
  });
});
