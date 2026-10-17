import { describe, expect, it } from 'vitest';
import { createSessionSnapshot } from './snapshot';

describe('createSessionSnapshot', () => {
  it('redacts secret values, secret-shaped fields and internal URLs at creation', () => {
    const snapshot = createSessionSnapshot(
      [
        {
          message: 'token=swordfish at http://gateway:8787/v1',
          environment: { SAFE: 'swordfish' },
        },
      ],
      ['swordfish'],
    );
    expect(JSON.stringify(snapshot)).not.toContain('swordfish');
    expect(JSON.stringify(snapshot)).not.toContain('gateway:8787');
  });

  it('excludes technical details and file contents unless opted in', () => {
    const entry = { message: 'ok', rawSdkEvent: { type: 'raw' }, fileContent: 'customer data' };
    expect(createSessionSnapshot([entry], [])).toEqual([{ message: 'ok' }]);
    expect(
      createSessionSnapshot([entry], [], { technicalDetails: true, outputFiles: true }),
    ).toEqual([entry]);
  });
});
