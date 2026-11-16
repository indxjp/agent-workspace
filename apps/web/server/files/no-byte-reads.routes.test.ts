/**
 * The files routes answer existence and metadata from the catalog, never from object bytes.
 * Harness: `routes.test-support.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryObjectStore } from '@agent-workspace/core/storage';
import { clearApplicationContext } from '../application-context';
import {
  download,
  expectError,
  installDefaultWorld,
  installSingleWorkspaceWorld,
  remove,
  rename,
  upload,
} from './routes.test-support';

afterEach(() => {
  clearApplicationContext();
});

describe('routes answer existence and metadata questions without reading object bytes (FX-3)', () => {
  let getCalls: string[];

  beforeEach(() => {
    installDefaultWorld();
    getCalls = [];
    const inner = createInMemoryObjectStore();
    installSingleWorkspaceWorld({
      objects: {
        ...inner,
        read(key, options) {
          getCalls.push(key);
          return inner.read(key, options);
        },
      },
    });
  });

  const uploadText = (filePath: string, text: string): Promise<Response> =>
    upload(filePath, text, { contentType: 'text/plain' });

  it('an upload answers its size and type without reading the object back', async () => {
    const response = await uploadText('a.txt', 'hello');
    expect(response.status).toBe(201);
    const body = (await response.json()) as { file: { sizeBytes: number; contentType: string } };
    expect(body.file).toMatchObject({ sizeBytes: 5, contentType: 'text/plain' });
    expect(getCalls).toEqual([]);
  });

  it('DELETE of a file reads no object bytes', async () => {
    expect((await uploadText('a.txt', 'hello')).status).toBe(201);
    getCalls = [];
    expect((await remove('a.txt')).status).toBe(204);
    expect(getCalls).toEqual([]);
  });

  it('PATCH of a file reads no object bytes and keeps them intact', async () => {
    expect((await uploadText('a.txt', 'hello')).status).toBe(201);
    getCalls = [];
    const response = await rename('a.txt', 'b.txt');
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { file: { sizeBytes: number; contentType: string } };
    expect(body.file).toMatchObject({ sizeBytes: 5, contentType: 'text/plain' });
    expect(getCalls).toEqual([]);
    expect(await (await download('b.txt')).text()).toBe('hello');
  });

  it('a folder move onto an existing destination is refused without reading bytes, and overwrites nothing', async () => {
    expect((await uploadText('src/a.txt', 'AAAA')).status).toBe(201);
    expect((await uploadText('src/b.txt', 'two')).status).toBe(201);
    expect((await uploadText('dst/a.txt', 'BBBB')).status).toBe(201);
    getCalls = [];
    await expectError(await rename('src', 'dst'), 409, 'name_conflict');
    expect(getCalls).toEqual([]);

    expect(await (await download('dst/a.txt')).text()).toBe('BBBB');
  });
});
