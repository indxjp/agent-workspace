import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { FilesClient } from './files.js';

const file = {
  id: 'YS9iIGMudHh0',
  path: 'a/b c.txt',
  kind: 'file',
  sizeBytes: 5,
  contentType: 'text/plain',
  lastModified: '2026-09-21T10:00:00.000Z',
};

const folder = {
  id: 'YQ',
  path: 'a',
  kind: 'folder',
  sizeBytes: null,
  contentType: null,
  lastModified: null,
};

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

function client(route: (request: RecordedRequest) => Response): {
  readonly files: FilesClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { files: new FilesClient(http), calls: api.calls };
}

async function sentBody(call: RecordedRequest | undefined): Promise<string> {
  const body = call?.init.body;
  if (!(body instanceof Blob)) throw new Error('expected a Blob body');
  return body.text();
}

function bytesResponse(bytes: Uint8Array, headers: Readonly<Record<string, string>>): Response {
  return new Response(new Blob([new Uint8Array(bytes)]), { status: 200, headers });
}

describe('FilesClient.list', () => {
  it('reads the root, then one folder, and unwraps the envelope', async () => {
    const { files, calls } = client(() => json(200, { files: [folder, file] }));
    expect(await files.list()).toHaveLength(2);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe('/api/files');
    expect(calls[0]?.url.search).toBe('');
    await files.list({ path: 'a/b c' });
    expect(calls[1]?.url.search).toBe('?path=a%2Fb+c');
  });

  it('surfaces a refused path by code', async () => {
    const { files } = client(() =>
      json(400, { error: { code: 'invalid_path', message: 'The "path" query is not valid.' } }),
    );
    const failure = await files.list({ path: '../x' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(400);
    expect((failure as ApiProblemError).code).toBe('invalid_path');
  });

  it('refuses a list without its envelope as a contract violation', async () => {
    const { files } = client(() => json(200, [file]));
    await expect(files.list()).rejects.toBeInstanceOf(ContractViolationError);
  });
});

describe('FilesClient.upload', () => {
  it('sends the raw bytes with the percent-encoded path header and the declared type', async () => {
    const { files, calls } = client(() => json(201, { file }));
    const uploaded = await files.upload('案件/b c.txt', utf8('hello'), {
      contentType: 'text/plain',
    });
    expect(uploaded.path).toBe('a/b c.txt');
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe('/api/files');
    expect(call?.headers.get('x-file-path')).toBe('%E6%A1%88%E4%BB%B6%2Fb%20c.txt');
    expect(call?.headers.get('x-resource-path-encoding')).toBe('percent-utf8');
    expect(call?.headers.get('content-type')).toBe('text/plain');
    expect(call?.headers.has('x-folder-path')).toBe(false);
    expect(call?.json).toBeUndefined();
    expect(await sentBody(call)).toBe('hello');
  });

  it('sends no content type when none is given, so the server stores null', async () => {
    const { files, calls } = client(() => json(201, { file: { ...file, contentType: null } }));
    const uploaded = await files.upload('a/b c.txt', utf8('hello'));
    expect(uploaded.contentType).toBeNull();
    expect(calls[0]?.headers.has('content-type')).toBe(false);
  });

  it('accepts a Blob and a ReadableStream as the body', async () => {
    const { files, calls } = client(() => json(201, { file }));
    await files.upload('a/b c.txt', new Blob([utf8('from blob')]));
    await files.upload(
      'a/b c.txt',
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(utf8('from '));
          controller.enqueue(utf8('stream'));
          controller.close();
        },
      }),
    );
    expect(await sentBody(calls[0])).toBe('from blob');
    expect(await sentBody(calls[1])).toBe('from stream');
  });

  it('surfaces the size limit, a reserved path, and a folder collision by code', async () => {
    const problems = [
      [413, 'request_body_too_large'],
      [400, 'reserved_path'],
      [409, 'name_conflict'],
    ] as const;
    for (const [status, code] of problems) {
      const { files } = client(() => json(status, { error: { code, message: 'refused' } }));
      const failure = await files.upload('x.txt', utf8('x')).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ApiProblemError);
      expect((failure as ApiProblemError).status).toBe(status);
      expect((failure as ApiProblemError).code).toBe(code);
    }
  });
});

describe('FilesClient.createFolder', () => {
  it('posts the folder path header with no body', async () => {
    const { files, calls } = client(() => json(201, { file: folder }));
    const created = await files.createFolder('a');
    expect(created.kind).toBe('folder');
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe('/api/files');
    expect(call?.headers.get('x-folder-path')).toBe('a');
    expect(call?.headers.get('x-resource-path-encoding')).toBe('percent-utf8');
    expect(call?.headers.has('content-type')).toBe(false);
    expect(call?.init.body).toBeUndefined();
  });

  it('surfaces an existing path by code', async () => {
    const { files } = client(() =>
      json(409, { error: { code: 'name_conflict', message: 'a already exists.' } }),
    );
    const failure = await files.createFolder('a').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('name_conflict');
  });
});

describe('FilesClient.download', () => {
  it('addresses the route by the base64url path and reads the attachment', async () => {
    const { files, calls } = client(() =>
      bytesResponse(utf8('hello'), {
        'content-type': 'text/plain',
        'content-disposition': `attachment; filename="b_c.txt"; filename*=UTF-8''b%20c.txt`,
      }),
    );
    const download = await files.download('a/b c.txt');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe('/api/files/YS9iIGMudHh0');
    if (download.kind !== 'file') throw new Error('expected bytes');
    expect(new TextDecoder().decode(download.bytes)).toBe('hello');
    expect(download.contentType).toBe('text/plain');
    expect(download.filename).toBe('b c.txt');
  });

  it('falls back to the quoted filename, then to the path, when the UTF-8 form is missing', async () => {
    const { files } = client((call) =>
      bytesResponse(
        utf8('x'),
        call.url.pathname.endsWith('YQ')
          ? { 'content-disposition': 'attachment' }
          : { 'content-disposition': 'attachment; filename="plain.txt"' },
      ),
    );
    const quoted = await files.download('plain.txt');
    expect(quoted.kind === 'file' ? quoted.filename : null).toBe('plain.txt');
    expect(quoted.kind === 'file' ? quoted.contentType : null).toBe('application/octet-stream');
    const bare = await files.download('a');
    expect(bare.kind === 'file' ? bare.filename : null).toBe('a');
  });

  it('answers a folder with its metadata rather than bytes', async () => {
    const { files } = client(() => json(200, { file: folder }));
    const download = await files.download('a');
    expect(download).toEqual({ kind: 'folder', file: folder });
  });

  it('refuses a folder answer that is not a file envelope', async () => {
    const { files } = client(() => json(200, { folder }));
    await expect(files.download('a')).rejects.toBeInstanceOf(ContractViolationError);
  });

  it('surfaces an unknown path by code', async () => {
    const { files } = client(() =>
      json(404, { error: { code: 'file_not_found', message: 'No file has that id.' } }),
    );
    const failure = await files.download('missing.txt').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(404);
    expect((failure as ApiProblemError).code).toBe('file_not_found');
  });
});

describe('FilesClient.move', () => {
  it('patches the JSON body the route parses and reads a file answer', async () => {
    const { files, calls } = client(() => json(200, { file: { ...file, path: 'c.txt' } }));
    const moved = await files.move('a/b c.txt', 'c.txt');
    expect(moved).toEqual({ file: { ...file, path: 'c.txt' } });
    const [call] = calls;
    expect(call?.method).toBe('PATCH');
    expect(call?.url.pathname).toBe('/api/files/YS9iIGMudHh0');
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.json).toEqual({ newPath: 'c.txt' });
  });

  it('reads a subtree outcome, complete or partial', async () => {
    const { files } = client((call) =>
      call.json !== null &&
      typeof call.json === 'object' &&
      'newPath' in call.json &&
      call.json.newPath === 'b'
        ? json(200, { status: 'ok', moved: 3 })
        : json(200, { status: 'partial', moved: 2, total: 3, remaining: ['a/x'] }),
    );
    expect(await files.move('a', 'b')).toEqual({ status: 'ok', moved: 3 });
    expect(await files.move('a', 'c')).toEqual({
      status: 'partial',
      moved: 2,
      total: 3,
      remaining: ['a/x'],
    });
  });

  it('surfaces a self-descendant target, an oversized subtree, and a conflict by code', async () => {
    const problems = [
      [409, 'self_descendant'],
      [413, 'subtree_too_large'],
      [409, 'name_conflict'],
      [404, 'file_not_found'],
    ] as const;
    for (const [status, code] of problems) {
      const { files } = client(() => json(status, { error: { code, message: 'refused' } }));
      const failure = await files.move('a', 'a/b').catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ApiProblemError);
      expect((failure as ApiProblemError).status).toBe(status);
      expect((failure as ApiProblemError).code).toBe(code);
    }
  });

  it('refuses an answer that is neither a file nor a subtree outcome', async () => {
    const { files } = client(() => json(200, { status: 'done' }));
    await expect(files.move('a', 'b')).rejects.toBeInstanceOf(ContractViolationError);
  });
});

describe('FilesClient.remove', () => {
  it('deletes a file with no query and reads the 204 as null', async () => {
    const { files, calls } = client(() => json(204, null));
    expect(await files.remove('a/b c.txt')).toBeNull();
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url.pathname).toBe('/api/files/YS9iIGMudHh0');
    expect(calls[0]?.url.search).toBe('');
  });

  it('asks for a recursive delete only when told to, and reads the outcome', async () => {
    const { files, calls } = client(() => json(200, { status: 'ok', deleted: ['a/x', 'a/y'] }));
    expect(await files.remove('a', { recursive: true })).toEqual({
      status: 'ok',
      deleted: ['a/x', 'a/y'],
    });
    expect(calls[0]?.url.search).toBe('?recursive=true');
    await files.remove('a', { recursive: false });
    expect(calls[1]?.url.search).toBe('');
  });

  it('surfaces a non-empty folder by code', async () => {
    const { files } = client(() =>
      json(409, { error: { code: 'folder_not_empty', message: 'a is not empty.' } }),
    );
    const failure = await files.remove('a').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(409);
    expect((failure as ApiProblemError).code).toBe('folder_not_empty');
  });
});

describe('FilesClient cancellation', () => {
  it('reports a pre-aborted signal as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { files } = client((call) => {
      expect(call.init.signal?.aborted).toBe(true);
      throw new DOMException('aborted', 'AbortError');
    });
    const failure = await files
      .download('a/b c.txt', { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
  });
});
