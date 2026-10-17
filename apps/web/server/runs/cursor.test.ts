import { describe, expect, it } from 'vitest';

import { readResumeCursor } from './cursor';
import { MAX_EVENT_ID } from './sse';

describe('readResumeCursor', () => {
  it('reports "absent" when neither the header nor the query parameter is present', () => {
    // A first connection. This is the defined meaning of "no cursor", not a fallback, which is
    // why it has its own arm rather than sharing one with a rejected value.
    expect(readResumeCursor(null, null)).toEqual({ kind: 'absent' });
  });

  it('reads the Last-Event-ID header', () => {
    expect(readResumeCursor('613', null)).toEqual({
      kind: 'after',
      id: 613n,
      subIndex: null,
      source: 'header',
    });
  });

  it('reads the ?after= query parameter when the header is absent', () => {
    expect(readResumeCursor(null, '42')).toEqual({
      kind: 'after',
      id: 42n,
      subIndex: null,
      source: 'query',
    });
  });

  it('prefers the header when both are present, because the browser owns the header', () => {
    expect(readResumeCursor('9', '1')).toEqual({
      kind: 'after',
      id: 9n,
      subIndex: null,
      source: 'header',
    });
  });

  it('accepts the largest storable id and rejects the next one', () => {
    expect(readResumeCursor(String(MAX_EVENT_ID), null)).toEqual({
      kind: 'after',
      id: MAX_EVENT_ID,
      subIndex: null,
      source: 'header',
    });
    // 19 digits, so a digit-count check alone would pass it, and it would then overflow the
    // bigint column that has to store it. This is the case R-13 calls out by name.
    const overflow = readResumeCursor('9223372036854775808', null);
    expect(overflow.kind).toBe('invalid');
  });

  it('rejects rather than silently restarting, for every malformed value', () => {
    for (const bad of [
      '',
      '   ',
      '-1',
      '1.',
      '.1',
      '1.2.3',
      '1.9999',
      '0x10',
      'abc',
      '12a',
      '99999999999999999999',
      '1 OR 1=1',
      "1'; drop table runs; --",
    ]) {
      const header = readResumeCursor(bad, null);
      expect(header.kind, `header ${JSON.stringify(bad)}`).toBe('invalid');
      const query = readResumeCursor(null, bad);
      expect(query.kind, `query ${JSON.stringify(bad)}`).toBe('invalid');
    }
  });

  it('never degrades an invalid header into "absent" just because a query parameter is missing', () => {
    const verdict = readResumeCursor('nope', null);
    expect(verdict.kind).toBe('invalid');
    if (verdict.kind !== 'invalid') return;
    expect(verdict.source).toBe('header');
    expect(verdict.reason).toContain('Last-Event-ID');
  });

  it('does not fall back to the query parameter when the header is present but invalid', () => {
    // Falling back would let a client with a broken header silently resume from a stale cursor.
    expect(readResumeCursor('nope', '5').kind).toBe('invalid');
  });

  it('reads a sub-index, which names one frame of a row that served several (ENG-03)', () => {
    // A `run_events` row recorded before ENG-03 is upgraded on read into one or more neutral
    // frames, which share the row's sequence. `api.ts` re-reads the row and drops what the client
    // already has, so the cursor has to carry the position as well as the sequence.
    expect(readResumeCursor('613.2', null)).toEqual({
      kind: 'after',
      id: 613n,
      subIndex: 2,
      source: 'header',
    });
    expect(readResumeCursor(null, '7.0')).toEqual({
      kind: 'after',
      id: 7n,
      subIndex: 0,
      source: 'query',
    });
    // Bounded, like the sequence: an unbounded sub-index is another client-supplied integer with
    // no known range, and one engine message does not become ten thousand frames.
    expect(readResumeCursor('7.999', null).kind).toBe('after');
    expect(readResumeCursor('7.1000', null).kind).toBe('invalid');
  });

  it('accepts zero, which means "everything from the beginning" stated explicitly', () => {
    expect(readResumeCursor('0', null)).toEqual({
      kind: 'after',
      id: 0n,
      subIndex: null,
      source: 'header',
    });
  });
});
