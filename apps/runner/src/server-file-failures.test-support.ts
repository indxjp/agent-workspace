import { createJsonLogger, type Logger } from '@agent-workspace/core/telemetry';
import { encodeUstar } from '@agent-workspace/runtime/transfer';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MiB } from '../../../tests/load/flat-memory.js';
import { createRunnerServer } from './server.js';

export function registerFileFailuresTests(): void {
  describe('the section 14.3 file endpoint failures', () => {
    async function withFilesServer(
      options: {
        maxFileArchiveBytes?: number;
        maxFileArchiveMembers?: number;
        workspaceIsFile?: boolean;
        logger?: Logger;
      },
      body: (url: string, workspace: string) => Promise<void>,
    ): Promise<void> {
      const root = await mkdtemp(path.join(tmpdir(), 'w3-runner-files-fail-'));
      const workspace = path.join(root, 'workspace');
      if (options.workspaceIsFile === true) await writeFile(workspace, 'not a directory');
      else await mkdir(workspace);
      const server = createRunnerServer({
        workspacePath: workspace,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        ...(options.maxFileArchiveBytes === undefined
          ? {}
          : { maxFileArchiveBytes: options.maxFileArchiveBytes }),
        ...(options.maxFileArchiveMembers === undefined
          ? {}
          : { maxFileArchiveMembers: options.maxFileArchiveMembers }),
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      try {
        await body(`http://127.0.0.1:${String(address.port)}/files`, workspace);
      } finally {
        // A refused upload leaves its request open until the client stops sending.
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    }

    it('answers a missing path with a 404 that does not carry the workspace root', async () => {
      await withFilesServer({}, async (url, workspace) => {
        const response = await fetch(`${url}?path=missing.txt`);
        const text = await response.text();
        expect(response.status).toBe(404);
        expect(JSON.parse(text)).toMatchObject({ error: 'file_not_found' });
        expect(text).not.toContain(workspace);
      });
    });

    it('answers a traversal request and a missing path parameter with a 400', async () => {
      await withFilesServer({}, async (url) => {
        const traversal = await fetch(`${url}?path=%252e%252e/x`);
        expect(traversal.status).toBe(400);
        expect(await traversal.json()).toMatchObject({ error: 'invalid_file_request' });

        const missing = await fetch(url);
        expect(missing.status).toBe(400);
        expect(await missing.json()).toEqual({
          error: 'invalid_file_request',
          message: 'at least one path query parameter is required',
        });
      });
    });

    it('answers a body that is not a tar archive with a 400', async () => {
      await withFilesServer({}, async (url) => {
        const response = await fetch(url, { method: 'POST', body: 'garbage' });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: 'invalid_archive' });
      });
    });

    it('refuses a collection over the size cap with a 413', async () => {
      await withFilesServer({ maxFileArchiveBytes: 4 }, async (url, workspace) => {
        await writeFile(path.join(workspace, 'five.txt'), '12345');
        const response = await fetch(`${url}?path=five.txt`);
        expect(response.status).toBe(413);
        expect(await response.json()).toMatchObject({ error: 'archive_too_large' });
      });
    });

    it('[US-STO-06][contract][run] POST /files refuses an archive whose files exceed the cap with a 413', async () => {
      await withFilesServer({ maxFileArchiveBytes: MiB }, async (url, workspace) => {
        const archive = encodeUstar([
          { path: 'big.bin', type: 'file', mode: 0o644, data: new Uint8Array(2 * MiB) },
        ]);
        let offset = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= archive.byteLength) controller.close();
            else controller.enqueue(archive.subarray(offset, (offset += 64 * 1024)));
          },
        });
        const response = await fetch(url, { method: 'POST', body, duplex: 'half' });
        expect(response.status).toBe(413);
        expect(await response.json()).toMatchObject({ error: 'archive_too_large' });
        await expect(readFile(path.join(workspace, 'big.bin'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      });
    });

    it('[US-STO-06][contract][run] POST /files refuses a headers-only archive over the member cap with a 413', async () => {
      await withFilesServer({ maxFileArchiveMembers: 2 }, async (url, workspace) => {
        const archive = encodeUstar(
          ['a.txt', 'b.txt', 'c.txt'].map((name) => ({
            path: name,
            type: 'file' as const,
            mode: 0o644,
            data: new Uint8Array(0),
          })),
        );
        const response = await fetch(url, { method: 'POST', body: archive });
        expect(response.status).toBe(413);
        expect(await response.json()).toMatchObject({ error: 'archive_too_large' });
        await expect(readFile(path.join(workspace, 'c.txt'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      });
    });

    it.each([
      [
        'joins a valid traceparent',
        `00-${'4bf92f3577b34da6a3ce929d0e0e4736'}-00f067aa0ba902b7-01`,
        true,
      ],
      ['ignores a malformed traceparent', 'not-a-traceparent', false],
    ])(
      'answers a server fault with a fixed 500 and logs a JSON line (%s)',
      async (_name, traceparent, joined) => {
        const lines: Record<string, unknown>[] = [];
        const logger = createJsonLogger({
          service: 'runner',
          write: (_level, line) => lines.push(JSON.parse(line) as Record<string, unknown>),
        });
        await withFilesServer({ workspaceIsFile: true, logger }, async (url, workspace) => {
          const archive = encodeUstar([
            { path: 'a.txt', type: 'file', mode: 0o600, data: Buffer.from('a') },
          ]);
          const response = await fetch(url, {
            method: 'POST',
            headers: { traceparent },
            body: Buffer.from(archive),
          });
          const text = await response.text();
          expect(response.status).toBe(500);
          expect(JSON.parse(text)).toEqual({
            error: 'internal_error',
            message: 'the workspace files could not be processed.',
          });
          expect(text).not.toContain(workspace);
          expect(lines).toHaveLength(1);
          expect(lines[0]).toMatchObject({
            level: 'error',
            service: 'runner',
            msg: '/files failed',
          });
          expect(lines[0]?.['traceId']).toBe(
            joined ? '4bf92f3577b34da6a3ce929d0e0e4736' : undefined,
          );
          expect(JSON.stringify(lines)).not.toContain('not-a-traceparent');
        });
      },
    );
  });
}
