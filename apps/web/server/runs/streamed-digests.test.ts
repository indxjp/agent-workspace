// @story US-STO-12
import { describe, expect, it } from 'vitest';

import { STREAMED_SHA256, withStreamedDigests } from './streamed-digests';

const real = 'a'.repeat(64);
const body = (...files: object[]) => ({ runId: 'run-1', resources: { files } });

describe('withStreamedDigests', () => {
  it('[US-STO-12][unit][run] fills each placeholder from the archive and leaves other references alone', () => {
    const filled = withStreamedDigests(
      body(
        { kind: 'file', path: 'storage/c/x.csv', sha256: STREAMED_SHA256 },
        { kind: 'file', path: 'notes.txt', sha256: real },
        { kind: 'directory', path: 'out' },
      ),
      new Map([['storage/c/x.csv', 'b'.repeat(64)]]),
    );
    expect(filled).toEqual(
      body(
        { kind: 'file', path: 'storage/c/x.csv', sha256: 'b'.repeat(64) },
        { kind: 'file', path: 'notes.txt', sha256: real },
        { kind: 'directory', path: 'out' },
      ),
    );
  });

  it('[US-STO-12][unit][run] fails the run rather than send a file the archive never read', () => {
    expect(() =>
      withStreamedDigests(
        body({ kind: 'file', path: 'storage/c/x.csv', sha256: STREAMED_SHA256 }),
        new Map(),
      ),
    ).toThrow('never read');
  });
});
