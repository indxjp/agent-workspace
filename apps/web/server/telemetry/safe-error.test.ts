import { describe, expect, it } from 'vitest';

import { errorNameOf, safeErrorCode, safeErrorFields } from './safe-error';

describe('what a log line may say about a thrown value', () => {
  it('names the class of an Error and the type of anything else', () => {
    expect(errorNameOf(new TypeError('x'))).toBe('TypeError');
    expect(errorNameOf('a string')).toBe('string');
    expect(errorNameOf(undefined)).toBe('undefined');
  });

  it.each(['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', '57P01', 'ETIMEDOUT'])(
    'keeps the system code %s',
    (code) => {
      expect(safeErrorCode(Object.assign(new Error('m'), { code }))).toBe(code);
    },
  );

  it.each([
    'sk-ant-SENTINEL-key-9f3c',
    'postgres://svc:pw@db/aw',
    'lowercase_code',
    'E',
    `E${'X'.repeat(40)}`,
    '',
    42,
    null,
  ])('drops the code %j, which is not from the closed alphabet', (code) => {
    expect(safeErrorCode(Object.assign(new Error('m'), { code }))).toBeUndefined();
  });

  it('reads a code off an Error only', () => {
    expect(safeErrorCode({ code: 'ECONNRESET' })).toBeUndefined();
    expect(safeErrorCode(new Error('no code'))).toBeUndefined();
  });

  it('gives the fields a log line carries, never the message', () => {
    const fields = safeErrorFields(Object.assign(new Error('secret sk-ant-1'), { code: 'EPIPE' }));
    expect(fields).toEqual({ errorName: 'Error', errorCode: 'EPIPE' });
    expect(safeErrorFields(new Error('plain'))).toEqual({ errorName: 'Error' });
  });
});
