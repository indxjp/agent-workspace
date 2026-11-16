/**
 * The paths a folder upload sends (#2086 Upload): a file inside a folder inside a folder, and an
 * empty subfolder. The Files screen reads a picked or dropped folder in the browser and sends one
 * `POST /api/files` per file with the file's path inside the folder on screen, then one per empty
 * folder; nothing here trusts that the browser built those paths well. Harness:
 * `routes.test-support.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as listRoute, POST as postRoute } from '../../app/api/files/route';
import { clearApplicationContext } from '../application-context';
import { WORKSPACE_A, expectError, installDefaultWorld, req } from './routes.test-support';

beforeEach(() => {
  installDefaultWorld();
});

afterEach(() => {
  clearApplicationContext();
});

/** `POST /api/files` with the path percent-encoded, as the SDK sends it from a browser. */
function encodedPost(header: 'x-file-path' | 'x-folder-path', path: string): Promise<Response> {
  return postRoute(
    req('POST', '/api/files', {
      workspace: WORKSPACE_A,
      ...(header === 'x-file-path' ? { body: new TextEncoder().encode('x') } : {}),
      headers: {
        [header]: encodeURIComponent(path),
        'x-resource-path-encoding': 'percent-utf8',
      },
    }),
  );
}

async function listed(path: string): Promise<string[]> {
  const query = path === '' ? '' : `?path=${encodeURIComponent(path)}`;
  const response = await listRoute(req('GET', `/api/files${query}`, { workspace: WORKSPACE_A }));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { files: { path: string; kind: string }[] };
  return body.files.map((file) => `${file.path}${file.kind === 'folder' ? '/' : ''}`).sort();
}

describe('a folder upload, file by file', () => {
  it('stores a nested path and lists every folder on the way to it', async () => {
    expect((await encodedPost('x-file-path', 'reports/photos/2026/議事録.txt')).status).toBe(201);
    expect((await encodedPost('x-file-path', 'reports/photos/a.jpg')).status).toBe(201);
    expect(await listed('reports')).toEqual(['reports/photos/']);
    expect(await listed('reports/photos')).toEqual([
      'reports/photos/2026/',
      'reports/photos/a.jpg',
    ]);
    expect(await listed('reports/photos/2026')).toEqual(['reports/photos/2026/議事録.txt']);
  });

  it('creates an empty subfolder, and answers 409 name_conflict for one already there', async () => {
    expect((await encodedPost('x-folder-path', 'reports/empty/inner')).status).toBe(201);
    expect(await listed('reports/empty')).toEqual(['reports/empty/inner/']);
    await expectError(
      await encodedPost('x-folder-path', 'reports/empty/inner'),
      409,
      'name_conflict',
    );
  });
});

describe('a folder upload cannot write outside the folder it was sent to', () => {
  // Each is what a modified browser could send as "a file's path inside the dropped folder".
  const refused = [
    ['a parent segment', 'photos/../../escape.txt'],
    ['a parent segment at the start', '../escape.txt'],
    ['a lone dot segment', 'photos/./a.txt'],
    ['an absolute path', '/etc/passwd'],
    ['a backslash', 'photos\\..\\escape.txt'],
    ['an empty segment', 'photos//a.txt'],
    ['a trailing slash', 'photos/'],
    ['a NUL byte', 'photos/a\u0000.txt'],
    ['a newline', 'photos/a\n.txt'],
    ['a percent-encoded parent segment', 'photos/%2e%2e/escape.txt'],
  ] as const;

  for (const [what, path] of refused) {
    it(`refuses a file path with ${what}`, async () => {
      await expectError(await encodedPost('x-file-path', path), 400, 'invalid_path');
    });
    it(`refuses an empty-folder path with ${what}`, async () => {
      await expectError(await encodedPost('x-folder-path', path), 400, 'invalid_path');
    });
  }

  it('wrote nothing for any of them', async () => {
    for (const [, path] of refused) {
      await encodedPost('x-file-path', path);
      await encodedPost('x-folder-path', path);
    }
    expect(await listed('')).toEqual([]);
  });

  it('refuses a path into the runner-private .claude folder', async () => {
    const response = await encodedPost('x-file-path', '.claude/settings.json');
    expect(response.status).toBe(400);
  });
});
