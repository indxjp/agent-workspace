/**
 * Write-back (US-STO-12): the run-wide byte budget refuses a folder the run can no longer afford to read.
 */
// @story US-STO-12
import { createHash } from 'node:crypto';

import { encodeUstar } from '@agent-workspace/runtime/transfer';
import { describe, expect, it } from 'vitest';

import {
  BLOCK,
  CONNECTION,
  CWD,
  FOLDER,
  reportsGrant,
  sealChecksum,
  writeBack,
} from './storage-writeback.test-support';

const MIB = 1024 * 1024;
const SIZE = 80 * MIB;

/** A one-file archive of `size` zero bytes under `folder`, streamed a MiB at a time. */
function zeroArchive(folder: string, name: string, size: number): ReadableStream<Uint8Array> {
  const empty = encodeUstar([
    { path: `${folder}/${name}`, type: 'file', mode: 0o644, data: Buffer.alloc(0) },
  ]);
  const header = Buffer.from(empty.subarray(0, BLOCK));
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  sealChecksum(header);
  const chunk = new Uint8Array(MIB);
  const parts: (() => Uint8Array)[] = [() => header];
  for (let left = size; left > 0; left -= MIB) {
    const length = Math.min(left, MIB);
    parts.push(() => chunk.subarray(0, length));
  }
  parts.push(() => new Uint8Array(BLOCK * 2));
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull: (controller) => {
      const part = parts[next];
      next += 1;
      if (part === undefined) controller.close();
      else controller.enqueue(part());
    },
  });
}

function zeroSha(size: number): string {
  const hash = createHash('sha256');
  const chunk = new Uint8Array(MIB);
  for (let left = size; left > 0; left -= MIB) hash.update(chunk.subarray(0, Math.min(left, MIB)));
  return hash.digest('hex');
}

describe('the run-wide byte budget', () => {
  it('[US-STO-12][unit][run] refuses a later folder once the run has read its budget', async () => {
    // Two folders of 80 MiB each: the first is read in full, the second exceeds what is left of
    // the run's 128 MiB. The first file is unchanged, so no body of it is buffered by this fake.
    const data = `${CWD}/storage/acme-data/data`;
    const result = await writeBack({
      grants: [reportsGrant(CONNECTION), reportsGrant(CONNECTION, 'data')],
      launchEntries: [
        {
          kind: 'file',
          path: 'storage/acme-data/reports/big.bin',
          access: 'read-write',
          sha256: zeroSha(SIZE),
        },
      ],
      streams: (path) =>
        path === FOLDER
          ? zeroArchive(FOLDER, 'big.bin', SIZE)
          : path === data
            ? zeroArchive(data, 'big.bin', SIZE)
            : null,
    });

    expect(result.attempts).toEqual([]);
    expect(result.labels()).toEqual([
      'run run-1 · 0 written · 1 unchanged · 0 conflicted · 1 refused · 0 failed · 0 bytes · refused: archive_refused',
    ]);
  });
});
