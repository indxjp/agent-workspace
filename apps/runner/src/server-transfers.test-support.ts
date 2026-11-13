import {
  decodeUstar,
  encodeUstarStream,
  RUN_FILES_MAX_BYTES,
} from '@agent-workspace/runtime/transfer';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generatedBody, MiB, peakRssGrowth } from '../../../tests/load/flat-memory.js';
import { collectWorkspace } from './files.js';
import { createRunnerServer } from './server.js';

export function registerFileTransfersTests(): void {
  describe('the section 14.3 file endpoints', () => {
    it('hydrates a tar under the configured workspace and collects it back', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'w3-runner-files-http-'));
      const source = path.join(root, 'source');
      const workspace = path.join(root, 'workspace');
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, 'hello.txt'), 'hello through HTTP\n');
      const archive = await collectWorkspace(source, ['hello.txt']);
      const server = createRunnerServer({ workspacePath: workspace });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      try {
        const posted = await fetch(`http://127.0.0.1:${String(address.port)}/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-tar' },
          body: archive.buffer.slice(
            archive.byteOffset,
            archive.byteOffset + archive.byteLength,
          ) as ArrayBuffer,
        });
        expect(posted.status).toBe(200);
        expect(await readFile(path.join(workspace, 'hello.txt'), 'utf8')).toBe(
          'hello through HTTP\n',
        );

        const collected = await fetch(
          `http://127.0.0.1:${String(address.port)}/files?path=hello.txt`,
        );
        expect(collected.status).toBe(200);
        expect(collected.headers.get('content-type')).toBe('application/x-tar');
        const entries = decodeUstar(new Uint8Array(await collected.arrayBuffer()));
        expect(Buffer.from(entries[0]?.data ?? []).toString('utf8')).toBe('hello through HTTP\n');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('POST /files streaming', () => {
    // @story US-STO-06
    it(
      '[US-STO-06][contract][run] POST /files streams a 128 MiB archive with flat memory',
      { timeout: 120_000 },
      async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'w3-runner-files-flat-'));
        const workspace = path.join(root, 'workspace');
        const runner = createRunnerServer({ workspacePath: workspace });
        // A plain sink that drains and answers 204, bypassing /files.
        const sink = createServer((req, res) => {
          req.resume();
          req.on('end', () => res.writeHead(204).end());
        });
        const listen = async (server: typeof sink): Promise<string> => {
          await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
          const address = server.address();
          if (address === null || typeof address === 'string') throw new Error('no address');
          return `http://127.0.0.1:${String(address.port)}`;
        };
        const post = (url: string, body: ReadableStream<Uint8Array>): Promise<Response> =>
          fetch(url, { method: 'POST', body, duplex: 'half' });
        const archiveOf = (name: string, size: number) => {
          const generated = generatedBody(size);
          const archive = encodeUstarStream(
            [
              {
                path: name,
                type: 'file',
                mode: 0o644,
                size,
                open: () => Promise.resolve(generated.body),
              },
            ],
            { maxBytes: RUN_FILES_MAX_BYTES },
          );
          return { archive, sha256: generated.sha256 };
        };
        try {
          const runnerUrl = `${await listen(runner)}/files`;
          const sinkUrl = await listen(sink);
          // The first large upload in a process grows RSS once by native cost that has nothing to do
          // with the code under test (PR #1757): pay it with 32 MiB sent straight to the sink, then
          // load /files itself with 1 MiB before the baseline.
          await (await post(sinkUrl, generatedBody(32 * MiB).body)).arrayBuffer();
          expect((await post(runnerUrl, archiveOf('warm.bin', MiB).archive)).status).toBe(200);
          await rm(path.join(workspace, 'warm.bin'));

          const { archive, sha256 } = archiveOf('big.bin', RUN_FILES_MAX_BYTES);
          let sent = 0;
          let nextSample = 4 * MiB;
          let allSent: () => void = () => undefined;
          const arrived = new Promise<void>((resolve) => {
            allSent = resolve;
          });
          let answer: Promise<Response> | undefined;
          const growth = await peakRssGrowth(async (sample) => {
            const sampled = archive.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  sent += chunk.byteLength;
                  // The archive's 512-byte header offsets every chunk, so sample on crossing a step.
                  if (sent >= nextSample) {
                    sample();
                    nextSample += 4 * MiB;
                  }
                  controller.enqueue(chunk);
                },
                flush: () => allSent(),
              }),
            );
            answer = post(runnerUrl, sampled);
            await Promise.race([arrived, answer]);
          });
          expect(growth).toBeLessThan(64 * MiB);
          const response = await answer;
          expect(response?.status).toBe(200);
          expect(await response?.json()).toEqual({ hydrated: ['big.bin'] });
          const onDisk = createHash('sha256');
          for await (const chunk of createReadStream(path.join(workspace, 'big.bin'))) {
            onDisk.update(chunk as Buffer);
          }
          expect(onDisk.digest('hex')).toBe(await sha256);
        } finally {
          sink.closeAllConnections();
          runner.closeAllConnections();
          await Promise.all([
            new Promise<void>((resolve) => sink.close(() => resolve())),
            new Promise<void>((resolve) => runner.close(() => resolve())),
          ]);
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  });
}
