/** What the input archive does with a connection file whose bytes are streamed (US-STO-12, §05). */
// @story US-STO-12
import { createHash } from 'node:crypto';

import { createInMemoryCatalog } from '@agent-workspace/core/db/unscoped';
import { createInMemoryObjectStore, streamToBytes } from '@agent-workspace/core/storage';
import { bytesToStream, decodeUstar } from '@agent-workspace/runtime/transfer';
import { describe, expect, it } from 'vitest';

import type { LaunchContext } from '../runs/environment';
import { createStorageService } from '../storage/service';
import type { RunFileSource } from './resource-loader';
import { createRuntimeWorkspaceLifecycle } from './workspace-lifecycle';

const context = {
  run: { id: 'run-1' },
  agent: { id: 'agent-1', workspaceId: 'workspace-1' },
  session: { id: 'session-1', agentId: 'agent-1' },
  principal: { userId: 'user-1', workspaceId: 'workspace-1' },
  prompt: 'work',
} as LaunchContext;

const quietLog = { info() {}, warn() {}, error() {}, child: () => quietLog };

const sha256Of = (text: string): string => createHash('sha256').update(text).digest('hex');

async function members(archive: ReadableStream<Uint8Array> | null) {
  return archive === null ? null : decodeUstar(await streamToBytes(archive));
}

describe('a streamed connection file in the input archive', () => {
  /** A reference that promises `listed` bytes and a source that streams `text`. */
  function streamed(text: string, listed: number) {
    const path = 'storage/acme-data/reports/a.csv';
    const source: RunFileSource = {
      objectId: null,
      streamed: true,
      open: () => Promise.resolve(bytesToStream(Buffer.from(text))),
    };
    return {
      file: {
        kind: 'file' as const,
        path,
        access: 'read' as const,
        size: listed,
        sha256: '0'.repeat(64),
      },
      source: [path, source] as const,
    };
  }
  const lifecycleOf = (item: ReturnType<typeof streamed>) =>
    createRuntimeWorkspaceLifecycle({
      // The input archive reads from the sources, never the service: it only has to be there.
      storage: createStorageService({
        catalog: () => Promise.resolve(createInMemoryCatalog().forWorkspace('workspace-1')),
        objects: createInMemoryObjectStore(),
        log: quietLog,
      }),
      granted: () =>
        Promise.resolve({ files: [item.file], skills: [], sources: new Map([item.source]) }),
      resources: { load: () => Promise.reject(new Error('no attachment was asked for')) },
    });

  it('[US-STO-12][unit][run] reports the digest of the bytes it streamed', async () => {
    const digests = new Map<string, string>();
    const archive = await lifecycleOf(streamed('abc', 3)).inputArchive(context, (path, sha256) =>
      digests.set(path, sha256),
    );
    await members(archive);
    expect(digests).toEqual(new Map([['storage/acme-data/reports/a.csv', sha256Of('abc')]]));
  });

  it.each([
    ['more', 'abcd'],
    ['fewer', 'ab'],
  ])(
    '[US-STO-12][unit][run] aborts with run_file_corrupt when the store yields %s bytes than it listed',
    async (_name, text) => {
      const archive = await lifecycleOf(streamed(text, 3)).inputArchive(context);
      await expect(members(archive)).rejects.toMatchObject({ code: 'run_file_corrupt' });
    },
  );
});
