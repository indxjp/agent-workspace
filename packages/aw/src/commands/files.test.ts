import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  FileResourceSchema,
  RemoveFileResponseSchema,
  fileRouteId,
} from '@indx-workspace/contracts/files';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, json, runCli, stdoutJson, tempDirectory, tempFile } from '../testing.js';

let directory: string;

beforeAll(async () => {
  directory = await tempDirectory();
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('aw files', () => {
  it('list (root and a folder) round-trips through the contract', async () => {
    const root = await runCli(['files', 'list', '--json'], {
      route: () => json(200, { files: [FIXTURES.folder] }),
    });
    expect(FileResourceSchema.array().parse(stdoutJson(root))).toEqual([FIXTURES.folder]);
    expect(root.calls[0]?.url.search).toBe('');
    const folder = await runCli(['files', 'list', '--path', 'docs'], {
      route: () => json(200, { files: [FIXTURES.file] }),
    });
    expect(folder.calls[0]?.url.search).toBe('?path=docs');
    expect(folder.stdout).toMatch(
      /^docs\/readme\.md\s+file\s+5\s+text\/markdown\s+2026-09-21T10:00:00\.000Z$/mu,
    );
  });

  it('uploads the bytes of a local file under the given path', async () => {
    const local = await tempFile(directory, 'readme.md', 'hello');
    const run = await runCli(['files', 'upload', 'docs/readme.md', local, '--json'], {
      route: () => json(201, { file: FIXTURES.file }),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    const call = run.calls[0];
    expect(call?.method).toBe('POST');
    expect(decodeURIComponent(call?.headers.get('x-file-path') ?? '')).toBe('docs/readme.md');
    expect(call?.body).toBeInstanceOf(Blob);
    expect(await (call?.body as Blob).text()).toBe('hello');
    expect(FileResourceSchema.parse(stdoutJson(run))).toEqual(FIXTURES.file);
    const missing = await runCli(['files', 'upload', 'docs/x', path.join(directory, 'absent')]);
    expect(missing.code).toBe(EXIT_CODE.usage);
  });

  // @story US-STO-01
  it('[US-STO-01][api][cli] aw files upload shows the catalog row it created, which carries no modification time', async () => {
    const local = await tempFile(directory, 'catalog.md', 'hello');
    const created = { ...FIXTURES.file, id: crypto.randomUUID(), lastModified: null };
    const run = await runCli(['files', 'upload', 'docs/readme.md', local, '--json'], {
      route: () => json(201, { file: created }),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(FileResourceSchema.parse(stdoutJson(run))).toEqual(created);
    expect(await (run.calls[0]?.body as Blob).text()).toBe('hello');
  });

  describe('upload --direct (#251)', () => {
    const PRESIGNED = {
      url: ['https://store.example.com/bucket/.attachments/s1/a.bin?sig', 'abc'].join('='),
      method: 'PUT',
      headers: { 'content-length': '5', 'x-amz-meta-test': 'yes' },
      expiresAt: '2026-09-21T10:05:00.000Z',
      path: '.attachments/s1/a.bin',
    };

    // @story US-STO-02
    it('[US-STO-02][api][cli] aw files upload --direct makes three calls: mint, PUT, complete', async () => {
      const local = await tempFile(directory, 'a.bin', 'hello');
      const run = await runCli(
        ['files', 'upload', '.attachments/s1/a.bin', local, '--direct', '--json'],
        {
          route: (request) => {
            if (request.url.host === 'store.example.com')
              return new Response(null, { status: 200 });
            return request.url.pathname.endsWith('/upload-complete')
              ? json(200, { file: FIXTURES.file })
              : json(201, PRESIGNED);
          },
        },
      );
      expect(run.code).toBe(EXIT_CODE.ok);
      const [mint, put, complete] = run.calls;
      expect(run.calls).toHaveLength(3);
      expect(mint?.url.host).toBe('aw.example.com');
      expect(mint?.url.pathname).toMatch(/\/upload-urls$/u);
      expect(mint?.json).toEqual({ sizeBytes: 5 });
      expect(mint?.body).not.toBeInstanceOf(Blob);
      expect(put?.url.host).toBe('store.example.com');
      expect(put?.method).toBe('PUT');
      expect(put?.headers.get('x-amz-meta-test')).toBe('yes');
      expect(put?.headers.has('authorization')).toBe(false);
      expect(complete?.method).toBe('POST');
      expect(complete?.url.pathname).toMatch(/\/upload-complete$/u);
      expect(FileResourceSchema.parse(stdoutJson(run))).toEqual(FIXTURES.file);
    });

    // @story US-STO-02
    it('[US-STO-02][api][cli] aw files upload --direct streams the local file instead of reading it into memory', async () => {
      const local = await tempFile(directory, 'd.bin', 'hello');
      const run = await runCli(['files', 'upload', 'd.bin', local, '--direct', '--json'], {
        route: (request) => {
          if (request.url.host === 'store.example.com') return new Response(null, { status: 200 });
          return request.url.pathname.endsWith('/upload-complete')
            ? json(200, { file: FIXTURES.file })
            : json(201, PRESIGNED);
        },
      });
      expect(run.code).toBe(EXIT_CODE.ok);
      const put = run.calls[1];
      // A file-backed Blob: fetch reads it from disk as it sends.
      expect(put?.body).toBeInstanceOf(Blob);
      expect(await (put?.body as Blob).text()).toBe('hello');
      const folder = await runCli(['files', 'upload', 'd.bin', directory, '--direct']);
      expect(folder.code).toBe(EXIT_CODE.usage);
      expect(folder.calls).toHaveLength(0);
    });

    it('fails when the object store refuses the bytes', async () => {
      const local = await tempFile(directory, 'b.bin', 'hello');
      const run = await runCli(['files', 'upload', 'b.bin', local, '--direct'], {
        route: (request) =>
          request.url.host === 'store.example.com'
            ? new Response(null, { status: 403 })
            : json(201, PRESIGNED),
      });
      expect(run.code).not.toBe(EXIT_CODE.ok);
      expect(run.stderr).toContain('403');
      expect(run.stderr).toContain('object store');
    });

    it('surfaces 501 when the store cannot sign, without sending any bytes', async () => {
      const local = await tempFile(directory, 'c.bin', 'hello');
      const run = await runCli(['files', 'upload', 'c.bin', local, '--direct'], {
        route: () =>
          json(501, {
            error: { code: 'direct_transfer_unsupported', message: 'No direct transfer.' },
          }),
      });
      expect(run.code).not.toBe(EXIT_CODE.ok);
      expect(run.calls).toHaveLength(1);
      expect(run.stderr).toContain('direct_transfer_unsupported');
    });
  });

  it('mkdir sends the folder header', async () => {
    const run = await runCli(['files', 'mkdir', 'docs'], {
      route: () => json(201, { file: FIXTURES.folder }),
    });
    expect(decodeURIComponent(run.calls[0]?.headers.get('x-folder-path') ?? '')).toBe('docs');
    expect(run.stdout).toContain('kind          folder');
  });

  describe('mkdir of a path that already exists (#899)', () => {
    const conflict = () =>
      json(409, { error: { code: 'name_conflict', message: 'docs already exists.' } });

    it('is a no-op that exits 0 and says "already exists" when the path is a folder', async () => {
      const run = await runCli(['files', 'mkdir', 'docs', '--json'], {
        route: (request) =>
          request.method === 'POST' ? conflict() : json(200, { files: [FIXTURES.folder] }),
      });
      expect(run.code).toBe(EXIT_CODE.ok);
      expect(run.stderr).toContain('docs already exists');
      expect(FileResourceSchema.parse(stdoutJson(run))).toEqual(FIXTURES.folder);
      expect(run.calls.map((call) => call.method)).toEqual(['POST', 'GET']);
      expect(run.calls[1]?.url.pathname).toBe('/api/files');
      expect(run.calls[1]?.url.search).toBe('');
    });

    it('keeps the 409 when the path is a file', async () => {
      const run = await runCli(['files', 'mkdir', 'docs/readme.md'], {
        route: (request) =>
          request.method === 'POST' ? conflict() : json(200, { files: [FIXTURES.file] }),
      });
      expect(run.code).toBe(EXIT_CODE.problem);
      expect(run.stderr).toContain('name_conflict');
      expect(run.calls[1]?.url.search).toBe('?path=docs');
    });

    it('keeps the 409 when the probe itself fails', async () => {
      const run = await runCli(['files', 'mkdir', 'docs'], {
        route: (request) =>
          request.method === 'POST'
            ? conflict()
            : json(403, { error: { code: 'forbidden', message: 'no access' } }),
      });
      expect(run.code).toBe(EXIT_CODE.problem);
      expect(run.stderr).toContain('name_conflict');
    });

    it('does not probe after any other failure', async () => {
      const run = await runCli(['files', 'mkdir', 'docs'], {
        route: () => json(400, { error: { code: 'invalid_path', message: 'bad path' } }),
      });
      expect(run.code).not.toBe(EXIT_CODE.ok);
      expect(run.calls).toHaveLength(1);
    });
  });

  it('download writes bytes to the named local file, or shows a folder', async () => {
    const target = path.join(directory, 'out.md');
    const run = await runCli(['files', 'download', 'docs/readme.md', target, '--json'], {
      route: () =>
        new Response('hello', {
          status: 200,
          headers: {
            'content-type': 'text/markdown',
            'content-disposition': 'attachment; filename="readme.md"',
          },
        }),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.url.pathname).toBe(`/api/files/${fileRouteId('docs/readme.md')}`);
    expect(await readFile(target, 'utf8')).toBe('hello');
    expect(stdoutJson(run)).toMatchObject({
      kind: 'file',
      filename: 'readme.md',
      sizeBytes: 5,
      savedTo: target,
    });
    const folder = await runCli(['files', 'download', 'docs', '--json'], {
      route: () => json(200, { file: FIXTURES.folder }),
    });
    expect(FileResourceSchema.parse(stdoutJson(folder))).toEqual(FIXTURES.folder);
  });

  // @story US-STO-01
  it('[US-STO-01][api][cli] aw files ls (list) shows catalog rows, which carry no modification time', async () => {
    const catalogFile = { ...FIXTURES.file, lastModified: null };
    const run = await runCli(['files', 'list', '--path', 'docs', '--json'], {
      route: () => json(200, { files: [catalogFile] }),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(FileResourceSchema.array().parse(stdoutJson(run))).toEqual([catalogFile]);
    const table = await runCli(['files', 'list', '--path', 'docs'], {
      route: () => json(200, { files: [catalogFile] }),
    });
    expect(table.code).toBe(EXIT_CODE.ok);
    expect(table.stdout).toMatch(/^docs\/readme\.md\s+file\s+5\s+text\/markdown/mu);
  });

  // @story US-STO-05
  it('[US-STO-05][api][cli] aw files download saves a streamed attachment byte for byte', async () => {
    const target = path.join(directory, 'streamed.bin');
    const bytes = Uint8Array.from({ length: 4096 }, (_, index) => index % 251);
    const run = await runCli(['files', 'download', 'blobs/streamed.bin', target, '--json'], {
      route: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, 1000));
              controller.enqueue(bytes.slice(1000));
              controller.close();
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/octet-stream',
              'content-length': String(bytes.byteLength),
              'content-disposition': 'attachment; filename="streamed.bin"',
              'x-content-type-options': 'nosniff',
            },
          },
        ),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(new Uint8Array(await readFile(target))).toEqual(bytes);
    expect(stdoutJson(run)).toMatchObject({
      kind: 'file',
      filename: 'streamed.bin',
      sizeBytes: bytes.byteLength,
      savedTo: target,
    });
  });

  // @story US-STO-05
  it('[US-STO-05][api][cli] aw files download --link', async () => {
    const signed = {
      url: ['https://store.example.com/bucket/obj?sig', 'abc'].join('='),
      method: 'GET',
      headers: {},
      expiresAt: '2026-09-21T10:10:00.000Z',
      path: 'docs/readme.md',
    };
    const target = path.join(directory, 'linked.md');
    const run = await runCli(
      ['files', 'download', 'docs/readme.md', target, '--link', '--ttl', '600', '--json'],
      { route: () => json(201, signed) },
    );
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.method).toBe('POST');
    expect(run.calls[0]?.url.pathname).toBe(
      `/api/files/${fileRouteId('docs/readme.md')}/download-urls`,
    );
    expect(run.calls[0]?.json).toEqual({ ttlSeconds: 600 });
    await expect(readFile(target)).rejects.toThrow();
    expect(stdoutJson(run)).toEqual({ url: signed.url, expiresAt: signed.expiresAt });
    expect(run.stderr).not.toContain(signed.url);

    const fallback = await runCli(['files', 'download', 'docs/readme.md', '--link', '--json'], {
      route: () => json(201, signed),
    });
    expect(fallback.calls[0]?.json).toEqual({});
  });

  // @story US-STO-03
  it('[US-STO-03][api][cli] aw files move prints the count of rows the server moved', async () => {
    const run = await runCli(['files', 'move', 'big', 'archive/big', '--json'], {
      route: () => json(200, { status: 'ok', moved: 10001 }),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.method).toBe('PATCH');
    expect(run.calls[0]?.json).toEqual({ newPath: 'archive/big' });
    expect(stdoutJson(run)).toEqual({ status: 'ok', moved: 10001 });
  });

  // @story US-STO-04
  it('[US-STO-04][api][cli] aw files remove sends recursive only when asked and treats 204 as done', async () => {
    const file = await runCli(['files', 'remove', 'docs/readme.md'], {
      route: () => json(204, null),
    });
    expect(file.code).toBe(EXIT_CODE.ok);
    expect(file.calls[0]?.method).toBe('DELETE');
    expect(file.calls[0]?.url.search).toBe('');
    expect(file.stdout).toBe('');

    const folder = await runCli(['files', 'remove', 'docs', '--recursive', '--json'], {
      route: () => json(200, { status: 'ok', deleted: ['docs/a.txt'] }),
    });
    expect(folder.code).toBe(EXIT_CODE.ok);
    expect(folder.calls[0]?.url.search).toBe('?recursive=true');
    expect(RemoveFileResponseSchema.parse(stdoutJson(folder))).toEqual({
      status: 'ok',
      deleted: ['docs/a.txt'],
    });
  });

  it('a partial move or remove prints what remains to stderr and exits non-zero (FX-10)', async () => {
    const removed = await runCli(['files', 'remove', 'docs', '--recursive', '--json'], {
      route: () => json(200, { status: 'partial', deleted: ['docs/a'], remaining: ['docs/b'] }),
    });
    expect(removed.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(removed)).toMatchObject({ status: 'partial', remaining: ['docs/b'] });
    expect(removed.stderr).toContain('docs/b');

    const moved = await runCli(['files', 'move', 'docs', 'archive', '--json'], {
      route: () =>
        json(200, {
          status: 'partial',
          phase: 'catalog',
          moved: 1,
          total: 1,
          remaining: ['docs/a'],
        }),
    });
    expect(moved.code).toBe(EXIT_CODE.problem);
    expect(moved.stderr).toContain('docs/a');
    expect(moved.stderr).toContain('repeat the same command');

    // After the delete phase a retry answers 409, so the CLI asks for the leftovers to be deleted.
    const leftover = await runCli(['files', 'move', 'docs', 'archive', '--json'], {
      route: () =>
        json(200, {
          status: 'partial',
          phase: 'delete',
          moved: 1,
          total: 1,
          remaining: ['docs/a'],
        }),
    });
    expect(leftover.code).toBe(EXIT_CODE.problem);
    expect(leftover.stderr).toContain('delete these leftover source keys:\n  docs/a');
    expect(leftover.stderr).not.toContain('repeat the same command');
  });
});
