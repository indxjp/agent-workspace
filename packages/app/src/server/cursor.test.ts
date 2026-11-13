import { describe, expect, it } from 'vitest';

import { readResumeCursor } from './cursor.js';

describe('readResumeCursor', () => {
  it('is absent with neither a header nor a query parameter', () => {
    expect(readResumeCursor(null, null)).toEqual({ kind: 'absent' });
  });

  it('reads the header and the query parameter as a sequence', () => {
    expect(readResumeCursor('42', null)).toEqual({ kind: 'after', id: 42n, source: 'header' });
    expect(readResumeCursor(null, '7')).toEqual({ kind: 'after', id: 7n, source: 'query' });
    expect(readResumeCursor(' 0 ', null)).toEqual({ kind: 'after', id: 0n, source: 'header' });
  });

  it('lets the header win over ?after=', () => {
    expect(readResumeCursor('9', '3')).toEqual({ kind: 'after', id: 9n, source: 'header' });
    expect(readResumeCursor('nope', '3')).toEqual({ kind: 'invalid', source: 'header' });
  });

  it('accepts the largest bigint and refuses 20 digits or more than a bigint holds', () => {
    expect(readResumeCursor('9223372036854775807', null)).toEqual({
      kind: 'after',
      id: 9_223_372_036_854_775_807n,
      source: 'header',
    });
    expect(readResumeCursor('9223372036854775808', null).kind).toBe('invalid');
    expect(readResumeCursor('12345678901234567890', null).kind).toBe('invalid');
  });

  it.each(['', '  ', '-1', '1.5', '1e3', '0x10', 'abc', '١٢'])(
    'is invalid, never absent, for %j',
    (raw) => {
      expect(readResumeCursor(raw, null)).toEqual({ kind: 'invalid', source: 'header' });
      expect(readResumeCursor(null, raw)).toEqual({ kind: 'invalid', source: 'query' });
    },
  );
});
