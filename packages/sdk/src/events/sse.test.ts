import { describe, expect, it } from 'vitest';

import { parseSseFrame, readSseFrames, readSseStream, splitSseFrames } from './sse.js';

/** A body that delivers the given chunks, then ends. */
function bodyOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('parseSseFrame', () => {
  it('reads event, id and JSON data, and ignores comments and retry', () => {
    expect(
      parseSseFrame(
        ': keep-alive\nretry: 3000\nevent: run.status\nid: 7\ndata: {"status":"running"}',
      ),
    ).toEqual({ event: 'run.status', id: '7', data: { status: 'running' } });
  });

  it('joins multi-line data, keeps non-JSON data verbatim, and gives a control frame no id', () => {
    expect(parseSseFrame('event: x\ndata: {"a":\ndata: 1}')).toEqual({
      event: 'x',
      id: null,
      data: { a: 1 },
    });
    expect(parseSseFrame('event: x\ndata: not json')).toEqual({
      event: 'x',
      id: null,
      data: 'not json',
    });
    expect(parseSseFrame('event: done')).toEqual({ event: 'done', id: null, data: null });
  });

  it('reads the at stamp when the server sends one, last one winning, and omits it otherwise', () => {
    expect(
      parseSseFrame('event: run.status\nid: 7\nat: 2026-10-13T10:00:00.000Z\ndata: {}'),
    ).toEqual({ event: 'run.status', id: '7', at: '2026-10-13T10:00:00.000Z', data: {} });
    expect(parseSseFrame('event: x\nat: a\nat: b\ndata: 1')?.at).toBe('b');
    expect(parseSseFrame('event: x\nid: 7\ndata: 1')).not.toHaveProperty('at');
  });

  it('drops a frame with no event name rather than inventing one', () => {
    expect(parseSseFrame('data: {"orphan":true}')).toBeNull();
  });
});

describe('splitSseFrames', () => {
  it('returns complete frames and the partial remainder, normalising CRLF', () => {
    expect(splitSseFrames('event: a\r\ndata: 1\r\n\r\nevent: b\ndata: 2\n\nevent: c\nda')).toEqual({
      frames: ['event: a\ndata: 1', 'event: b\ndata: 2'],
      rest: 'event: c\nda',
    });
  });

  it('normalises lone CR line endings inside complete frames', () => {
    expect(splitSseFrames('event: a\rdata: 1\r\revent: b\ndata: 2\n\n')).toEqual({
      frames: ['event: a\ndata: 1', 'event: b\ndata: 2'],
      rest: '',
    });
  });
});

describe('readSseFrames', () => {
  it('reassembles frames split across chunks and a multi-byte character across a boundary', async () => {
    const chunks = ['event: sdk-event\nid: 1\ndata: {"text":"caf', 'é"}\n\nevent: do', 'ne\n\n'];
    const frames = [];
    for await (const frame of readSseFrames(bodyOf(chunks))) frames.push(frame);
    expect(frames).toEqual([
      { event: 'sdk-event', id: '1', data: { text: 'café' } },
      { event: 'done', id: null, data: null },
    ]);
  });

  it('treats CRLF across chunks as one line ending and a lone CR as one line ending', async () => {
    const frames = [];
    for await (const frame of readSseFrames(
      bodyOf(['event: first\r', '\ndata: 1\r\revent: second\rdata: 2\r\r']),
    )) {
      frames.push(frame);
    }
    expect(frames).toEqual([
      { event: 'first', id: null, data: 1 },
      { event: 'second', id: null, data: 2 },
    ]);
  });

  it('cancels the body when the consumer stops early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: a\n\nevent: b\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const frame of readSseFrames(body)) {
      expect(frame.event).toBe('a');
      break;
    }
    expect(cancelled).toBe(true);
  });
});

describe('readSseStream (issue #250, K-3)', () => {
  async function read(text: string): Promise<{ hints: number[]; frames: unknown[] }> {
    const hints: number[] = [];
    const frames: unknown[] = [];
    for await (const frame of readSseStream(bodyOf([text]), undefined, (ms) => hints.push(ms))) {
      frames.push(frame);
    }
    return { hints, frames };
  }

  it('surfaces a retry: of ASCII digits, sent in a block of its own, as milliseconds', async () => {
    const { hints, frames } = await read(
      'retry: 10000\n\nevent: run.status\nid: 1\ndata: {"status":"running"}\n\n',
    );
    expect(hints).toEqual([10000]);
    expect(frames).toEqual([{ event: 'run.status', id: '1', data: { status: 'running' } }]);
  });

  it('ignores a retry: that is not ASCII digits only, as HTML §9.2 requires', async () => {
    const { hints } = await read(
      'retry: 1e4\n\nretry: -1\n\nretry:\n\nretry: 10 \n\nretry: ١٠\n\nevent: done\n\n',
    );
    expect(hints).toEqual([]);
  });

  it('reads retry: inside a named frame without changing its other fields, the last valid one winning', async () => {
    const { hints, frames } = await read(
      'event: x\nretry: 500\nid: 7\nretry: 2000\nretry: soon\ndata: 1\n\n',
    );
    expect(hints).toEqual([2000]);
    expect(frames).toEqual([{ event: 'x', id: '7', data: 1 }]);
  });

  it('keeps readSseFrames itself silent about retry:', async () => {
    const frames = [];
    for await (const frame of readSseFrames(bodyOf(['retry: 10000\n\nevent: done\n\n']))) {
      frames.push(frame);
    }
    expect(frames).toEqual([{ event: 'done', id: null, data: null }]);
  });
});
