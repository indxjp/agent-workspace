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

  it('move and remove, with --recursive for a folder', async () => {
    const move = await runCli(['files', 'move', 'docs', 'archive/docs', '--json'], {
      route: () => json(200, { status: 'ok', moved: 2 }),
    });
    expect(move.calls[0]?.method).toBe('PATCH');
    expect(move.calls[0]?.json).toEqual({ newPath: 'archive/docs' });
    expect(stdoutJson(move)).toEqual({ status: 'ok', moved: 2 });

    const file = await runCli(['files', 'remove', 'docs/readme.md'], {
      route: () => json(204, null),
    });
    expect(file.code).toBe(EXIT_CODE.ok);
    expect(file.calls[0]?.url.search).toBe('');
    expect(file.stdout).toBe('');

    const folder = await runCli(['files', 'remove', 'docs', '--recursive', '--json'], {
      route: () => json(200, { status: 'ok', deleted: ['docs/readme.md', 'docs'] }),
    });
    expect(folder.calls[0]?.url.search).toBe('?recursive=true');
    expect(RemoveFileResponseSchema.parse(stdoutJson(folder))).toEqual({
      status: 'ok',
      deleted: ['docs/readme.md', 'docs'],
    });
  });
});
