import { describe, expect, it } from 'vitest';

import { decodeFileId, encodeFileId } from './file-id';

describe('encodeFileId / decodeFileId', () => {
  it('round-trips a plain path', () => {
    const id = encodeFileId('contracts/agreement.pdf');
    expect(decodeFileId(id)).toBe('contracts/agreement.pdf');
  });

  it('never produces a "/" in the id, whatever the path contains', () => {
    const id = encodeFileId('a/b/c/d.txt');
    expect(id.includes('/')).toBe(false);
  });

  it('round-trips unicode and spaces', () => {
    const path = 'reports/Q3 report (éè).pdf';
    expect(decodeFileId(encodeFileId(path))).toBe(path);
  });

  it('rejects a segment that is not valid base64url', () => {
    expect(decodeFileId('not base64url!!')).toBeNull();
    expect(decodeFileId('has/slash')).toBeNull();
  });

  it('rejects a segment this module never minted, even if Buffer.from tolerates it', () => {
    // A single base64url character decodes (Node drops the leftover bits) but does not
    // round-trip back to itself, so it cannot be something this module's own encoder produced.
    expect(decodeFileId('A')).toBeNull();
  });
});
