import { MAX_UPLOAD_BYTES } from '@indx-workspace/contracts/files';
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

describe('FilesClient.search', () => {
  it('sends a percent-encoded Japanese query and parses the hits', async () => {
    const body = {
      hits: [{ path: 'manuals/pump.pdf', page: 3, snippet: '…保守手順…', score: 0.5 }],
      pending: 1,
    };
    const { files, calls } = client(() => json(200, body));
    expect(await files.search('保守 手順', { limit: 5 })).toEqual(body);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe('/api/files/search');
    expect(calls[0]?.url.searchParams.get('q')).toBe('保守 手順');
    expect(calls[0]?.url.searchParams.get('limit')).toBe('5');
  });

  it('surfaces a refused query by code and a malformed answer as drift', async () => {
    const refused = client(() =>
      json(400, { error: { code: 'invalid_search_query', message: 'Pass "q".' } }),
    );
    const failure = await refused.files.search('&').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('invalid_search_query');
    const drift = client(() => json(200, { hits: 'none' }));
    await expect(drift.files.search('x')).rejects.toBeInstanceOf(ContractViolationError);
  });
});

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

const presigned = {
  url: 'https://store.example.com/files/a/b%20c.txt?sig=1',
  method: 'PUT',
  headers: { 'content-type': 'text/plain' },
  expiresAt: '2026-09-21T10:05:00.000Z',
  path: 'a/b c.txt',
};

describe('FilesClient.createUploadUrl and createDownloadUrl', () => {
  it('posts the size, type and lifetime to the path’s upload-urls route', async () => {
    const { files, calls } = client(() => json(201, presigned));
    const url = await files.createUploadUrl('a/b c.txt', {
      sizeBytes: 5,
      contentType: 'text/plain',
      ttlSeconds: 120,
    });
    expect(url).toEqual(presigned);
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe('/api/files/YS9iIGMudHh0/upload-urls');
    expect(JSON.parse(call?.init.body as string)).toEqual({
      sizeBytes: 5,
      contentType: 'text/plain',
      ttlSeconds: 120,
    });
  });

  it('omits what the caller left out, and sends an empty object for a download', async () => {
    const { files, calls } = client(() => json(201, { ...presigned, method: 'GET', headers: {} }));
    await files.createUploadUrl('a/b c.txt', { sizeBytes: 0 });
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ sizeBytes: 0 });
    const download = await files.createDownloadUrl('a/b c.txt');
    expect(download.method).toBe('GET');
    expect(calls[1]?.url.pathname).toBe('/api/files/YS9iIGMudHh0/download-urls');
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({});
  });

  it('refuses a response that is not a presigned URL as a contract violation', async () => {
    const { files } = client(() => json(201, { ...presigned, url: 'javascript:alert(1)' }));
    await expect(files.createUploadUrl('a', { sizeBytes: 1 })).rejects.toBeInstanceOf(
      ContractViolationError,
    );
  });

  it('surfaces a store that cannot sign by its code', async () => {
    const { files } = client(() =>
      json(501, { error: { code: 'direct_transfer_unsupported', message: 'No direct transfer.' } }),
    );
    const failure = await files.createUploadUrl('a', { sizeBytes: 1 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(501);
    expect((failure as ApiProblemError).code).toBe('direct_transfer_unsupported');
  });

  it('reports an aborted request as an aborted transport failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const { files } = client(() => {
      throw new DOMException('aborted', 'AbortError');
    });
    const failure = await files
      .createDownloadUrl('a', {}, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportError);
    expect((failure as TransportError).aborted).toBe(true);
  });

  it('authenticates with a browser token as a bearer and sends no cookie', async () => {
    const api = fetchDouble(() => json(201, presigned));
    const http = new HttpClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'browser-token', token: 'awt_live_x' },
      fetch: api.fetch,
    });
    await new FilesClient(http).createUploadUrl('a', { sizeBytes: 1 });
    const [call] = api.calls;
    expect(call?.headers.get('authorization')).toBe('Bearer awt_live_x');
    expect(call?.headers.get('cookie')).toBeNull();
    expect(call?.init.credentials).not.toBe('include');
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

// #1991 SDK-1: a stream is buffered before any request, so the signal must reach the buffering.
describe('FilesClient upload source lifetime', () => {
  /** A source that sends one chunk and then never ends, recording its cancellation. */
  function endless(): {
    readonly stream: ReadableStream<Uint8Array>;
    readonly cancelled: unknown[];
  } {
    const cancelled: unknown[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(utf8('partial'));
      },
      cancel(reason) {
        cancelled.push(reason);
      },
    });
    return { stream, cancelled };
  }

  it.each([false, true])(
    'aborting before the source ends cancels it and sends nothing (direct: %s)',
    async (direct) => {
      const { stream, cancelled } = endless();
      const { files, calls } = client(() => json(201, { file }));
      const controller = new AbortController();
      const failure = files
        .upload('a/b c.txt', stream, { signal: controller.signal, direct })
        .catch((e: unknown) => e);
      controller.abort();

      const error = await failure;
      expect(error).toBeInstanceOf(TransportError);
      expect((error as TransportError).aborted).toBe(true);
      expect(cancelled).toHaveLength(1);
      expect(stream.locked).toBe(false);
      expect(calls).toEqual([]);
    },
  );

  it('reports a failing source as a transport failure that keeps its cause', async () => {
    const broken = new Error('disk read failed');
    const { files, calls } = client(() => json(201, { file }));
    const error = await files
      .upload(
        'a/b c.txt',
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(broken);
          },
        }),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).aborted).toBe(false);
    expect((error as TransportError).cause).toBe(broken);
    expect(calls).toEqual([]);
  });

  it('refuses a chunk that is not a Uint8Array instead of uploading wrong bytes', async () => {
    const { files, calls } = client(() => json(201, { file }));
    const strings = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue('abc');
        controller.close();
      },
    });
    const error = await files
      .upload('a/b c.txt', strings as ReadableStream<Uint8Array>)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).aborted).toBe(false);
    expect((error as TransportError).cause).toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
  });
});

describe('FilesClient signed uploads', () => {
  /** A Blob of `size` bytes made of one shared 1 MiB part, so nothing near 64 MiB is allocated. */
  function largeBlob(size: number): Blob {
    const mebibyte = new Blob([new Uint8Array(1024 * 1024)]);
    const whole = Array.from({ length: Math.floor(size / mebibyte.size) }, () => mebibyte);
    return new Blob([...whole, new Uint8Array(size % mebibyte.size)]);
  }

  const storeUrl = ['https://store.example.com/files/a/b%20c.txt?sig', 'x'].join('=');
  const target = { ...presigned, url: storeUrl };

  /** The control plane answers the mint and complete; the store answers the PUT with `put`. */
  function signedClient(put: () => Response = () => new Response(null, { status: 200 })) {
    return client((request) => {
      if (request.url.host === 'store.example.com') return put();
      if (request.url.pathname.endsWith('/upload-urls')) return json(201, target);
      if (request.url.pathname.endsWith('/upload-complete')) return json(200, { file });
      return json(201, { file });
    });
  }

  const routes = (calls: readonly RecordedRequest[]): string[] =>
    calls.map((call) => `${call.method} ${call.url.host}${call.url.pathname}`);

  // @story US-STO-02
  it('[US-STO-02][api][sdk] upload above 64 MiB uses a signed link and completes', async () => {
    const big = largeBlob(MAX_UPLOAD_BYTES + 1);
    const { files, calls } = signedClient();
    expect(await files.upload('a/b c.txt', big)).toEqual(file);
    expect(routes(calls)).toEqual([
      'POST aw.example.com/api/files/YS9iIGMudHh0/upload-urls',
      'PUT store.example.com/files/a/b%20c.txt',
      'POST aw.example.com/api/files/YS9iIGMudHh0/upload-complete',
    ]);
    expect(calls[0]?.json).toEqual({ sizeBytes: MAX_UPLOAD_BYTES + 1 });
    expect(calls[1]?.init.body).toBe(big);
    expect(calls[1]?.headers.has('authorization')).toBe(false);
    expect(calls[1]?.headers.has('x-agent-workspace-contracts')).toBe(false);
    expect(calls[2]?.init.body).toBeUndefined();
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] direct sends small bytes through the signed link as declared', async () => {
    const { files, calls } = signedClient();
    const bytes = utf8('hello');
    await files.upload('a/b c.txt', bytes, { direct: true, contentType: 'text/plain' });
    expect(routes(calls)).toHaveLength(3);
    expect(calls[0]?.json).toEqual({ sizeBytes: 5, contentType: 'text/plain' });
    expect(calls[1]?.init.body).toEqual(bytes);
    expect(calls[1]?.headers.get('content-type')).toBe('text/plain');
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] direct buffers a stream body, mints its size and PUTs a Blob', async () => {
    const { files, calls } = signedClient();
    const stream = new Blob([utf8('hello')]).stream();
    await files.upload('a/b c.txt', stream, { direct: true });
    expect(routes(calls)).toHaveLength(3);
    expect(calls[0]?.json).toEqual({ sizeBytes: 5 });
    expect(calls[1]?.init.body).toBeInstanceOf(Blob);
    expect(calls[1]?.init.credentials).toBe('omit');
  });

  // @story US-STO-02
  it("[US-STO-02][api][sdk] direct hands the caller's bytes to the store without a copy", async () => {
    const { files, calls } = signedClient();
    const bytes = utf8('hello');
    await files.upload('a/b c.txt', bytes, { direct: true });
    const body = calls[1]?.init.body;
    expect(body).toBeInstanceOf(Uint8Array);
    expect(body instanceof Uint8Array ? body.buffer : null).toBe(bytes.buffer);
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] a stream with a declared size above 64 MiB goes straight to the signed link', async () => {
    const { files, calls } = signedClient();
    let pulled = 0;
    // Never read by the double; a buffering upload would drain these four chunks before minting.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 4) controller.close();
        else controller.enqueue(new Uint8Array(1024));
      },
    });
    const sizeBytes = MAX_UPLOAD_BYTES + 1;
    expect(await files.upload('a/b c.txt', stream, { sizeBytes })).toEqual(file);
    expect(routes(calls)).toEqual([
      'POST aw.example.com/api/files/YS9iIGMudHh0/upload-urls',
      'PUT store.example.com/files/a/b%20c.txt',
      'POST aw.example.com/api/files/YS9iIGMudHh0/upload-complete',
    ]);
    expect(calls[0]?.json).toEqual({ sizeBytes });
    expect(calls[1]?.init.body).toBe(stream);
    expect(calls[1]?.init).toMatchObject({ duplex: 'half', credentials: 'omit' });
    // A ReadableStream starts by pulling once to fill its queue; nothing more was read.
    expect(pulled).toBeLessThanOrEqual(1);
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] refuses a declared size that is not a byte count before any request', async () => {
    const { files, calls } = signedClient();
    for (const sizeBytes of [-1, 1.5, Number.NaN]) {
      const failure = await files
        .upload('a', new Blob([utf8('x')]).stream(), { sizeBytes })
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(TypeError);
    }
    expect(calls).toHaveLength(0);
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] refuses a declared size that disagrees with a sized body', async () => {
    const { files, calls } = signedClient();
    const failure = await files
      .upload('a', utf8('hello'), { sizeBytes: 4 })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] a small body without direct stays one relay call', async () => {
    const { files, calls } = signedClient();
    await files.upload('a/b c.txt', utf8('hello'));
    expect(routes(calls)).toEqual(['POST aw.example.com/api/files']);
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] a refused PUT surfaces the store status and never completes', async () => {
    const { files, calls } = signedClient(() => new Response('<Error/>', { status: 403 }));
    const failure = await files.upload('a', utf8('x'), { direct: true }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).status).toBe(403);
    expect((failure as ApiProblemError).message).toContain('object store refused the PUT');
    expect(routes(calls).filter((call) => call.endsWith('/upload-complete'))).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] a store that cannot sign falls back to the relay unless direct', async () => {
    const unsupported = json(501, {
      error: { code: 'direct_transfer_unsupported', message: 'No direct transfer.' },
    });
    const big = largeBlob(MAX_UPLOAD_BYTES + 1);
    const fallback = client((request) =>
      request.url.pathname.endsWith('/upload-urls')
        ? unsupported.clone()
        : json(413, { error: { code: 'request_body_too_large', message: 'Too large.' } }),
    );
    const refused = await fallback.files.upload('a', big).catch((e: unknown) => e);
    expect((refused as ApiProblemError).code).toBe('request_body_too_large');
    expect(routes(fallback.calls)).toEqual([
      'POST aw.example.com/api/files/YQ/upload-urls',
      'POST aw.example.com/api/files',
    ]);

    const forced = client(() => unsupported.clone());
    const failure = await forced.files
      .upload('a', utf8('x'), { direct: true })
      .catch((e: unknown) => e);
    expect((failure as ApiProblemError).code).toBe('direct_transfer_unsupported');
    expect(forced.calls).toHaveLength(1);
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] a declared stream above 64 MiB is not buffered when the store cannot sign', async () => {
    const unsupported = client(() =>
      json(501, { error: { code: 'direct_transfer_unsupported', message: 'No direct transfer.' } }),
    );
    let pulled = 0;
    // A fallback would drain these four chunks into memory and then ask the relay to take them.
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 1;
          if (pulled > 4) controller.close();
          else controller.enqueue(new Uint8Array(1024));
        },
      },
      { highWaterMark: 0 },
    );
    const failure = await unsupported.files
      .upload('a', stream, { sizeBytes: MAX_UPLOAD_BYTES + 1 })
      .catch((e: unknown) => e);
    expect((failure as ApiProblemError).code).toBe('direct_transfer_unsupported');
    expect(routes(unsupported.calls)).toEqual(['POST aw.example.com/api/files/YQ/upload-urls']);
    expect(pulled).toBe(0);
  });

  // @story US-STO-02
  it('[US-STO-02][api][sdk] completeUpload posts no body and surfaces upload_not_verified', async () => {
    const ok = client(() => json(200, { file }));
    expect(await ok.files.completeUpload('a/b c.txt')).toEqual(file);
    expect(ok.calls[0]?.method).toBe('POST');
    expect(ok.calls[0]?.url.pathname).toBe('/api/files/YS9iIGMudHh0/upload-complete');
    expect(ok.calls[0]?.init.body).toBeUndefined();

    const drift = client(() => json(200, { file: { id: 1 } }));
    await expect(drift.files.completeUpload('a')).rejects.toBeInstanceOf(ContractViolationError);

    const unverified = client(() =>
      json(409, { error: { code: 'upload_not_verified', message: 'Not uploaded.' } }),
    );
    const failure = await unverified.files.completeUpload('a').catch((e: unknown) => e);
    expect((failure as ApiProblemError).status).toBe(409);
    expect((failure as ApiProblemError).code).toBe('upload_not_verified');
  });
});
