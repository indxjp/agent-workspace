import { describe, expect, it } from 'vitest';

import {
  CreateDownloadUrlRequestSchema,
  CreateUploadUrlRequestSchema,
  DEFAULT_SEARCH_LIMIT,
  FILES_PROBLEM_CODES,
  FILE_KINDS,
  PresignedUrlSchema,
  FileListResponseSchema,
  FileResourceSchema,
  FileResponseSchema,
  FileSearchHitSchema,
  FileSearchQuerySchema,
  FileSearchResponseSchema,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_QUERY_CHARS,
  MAX_SUBTREE_OBJECTS,
  MAX_UPLOAD_BYTES,
  SIGNED_UPLOAD_HARD_MAX_BYTES,
  MoveFileResponseSchema,
  RESOURCE_PATH_ENCODING_HEADER,
  RESOURCE_PATH_ENCODING_PERCENT_UTF8,
  RemoveFileResponseSchema,
  SubtreeDeleteOutcomeSchema,
  SubtreeMoveOutcomeSchema,
  decodeResourcePathHeader,
  fileRouteId,
  resourcePathHeaders,
} from './files.js';

const file = {
  id: 'Y29udHJhY3RzL2FncmVlbWVudC5wZGY',
  path: 'contracts/agreement.pdf',
  kind: 'file',
  sizeBytes: 1024,
  contentType: 'application/pdf',
  lastModified: '2026-09-21T10:00:00.000Z',
};

const folder = {
  id: 'Y29udHJhY3Rz',
  path: 'contracts',
  kind: 'folder',
  sizeBytes: null,
  contentType: null,
  lastModified: null,
};

describe('resource path headers', () => {
  it('round-trips Japanese filenames through ASCII-only browser headers', () => {
    const path = '案件/見積書_日本語.txt';
    const headers = resourcePathHeaders('x-file-path', path);

    expect(() => new Headers(headers)).not.toThrow();
    expect(headers['x-file-path']).toMatch(/^[\x20-\x7e]+$/u);
    expect(
      decodeResourcePathHeader(
        headers['x-file-path'] ?? null,
        headers[RESOURCE_PATH_ENCODING_HEADER] ?? null,
      ),
    ).toEqual({ ok: true, value: path });
  });

  it('keeps percent signs exact instead of treating legacy raw paths as encoded', () => {
    expect(decodeResourcePathHeader('reports/50%.txt', null)).toEqual({
      ok: true,
      value: 'reports/50%.txt',
    });
  });

  it('rejects unsupported and malformed marked encodings at the HTTP boundary', () => {
    expect(decodeResourcePathHeader('file.txt', 'base64')).toEqual({
      ok: false,
      code: 'unsupported_path_encoding',
    });
    expect(decodeResourcePathHeader('%E3%81', RESOURCE_PATH_ENCODING_PERCENT_UTF8)).toEqual({
      ok: false,
      code: 'invalid_path_encoding',
    });
  });
});

describe('fileRouteId', () => {
  it('base64url-encodes the UTF-8 path without padding, so a slash never splits a segment', () => {
    expect(fileRouteId('a/b c.txt')).toBe('YS9iIGMudHh0');
    expect(fileRouteId('a')).toBe('YQ');
    expect(fileRouteId('ab')).toBe('YWI');
    expect(fileRouteId('reports/50%.txt')).toBe('cmVwb3J0cy81MCUudHh0');
    expect(fileRouteId('案件/見積書_日本語.txt')).toBe('5qGI5Lu2L-imi-epjeabuF_ml6XmnKzoqp4udHh0');
    expect(fileRouteId('')).toBe('');
  });

  it('yields only URL-safe characters, whatever the path contains', () => {
    expect(fileRouteId("~/?#[]@!$&'()*+,;=  ÿ")).toMatch(/^[A-Za-z0-9_-]+$/u);
  });
});

describe('FileResourceSchema', () => {
  it('accepts a file and a folder', () => {
    expect(FileResourceSchema.safeParse(file).success).toBe(true);
    expect(FileResourceSchema.safeParse(folder).success).toBe(true);
    expect(FileResourceSchema.safeParse({ ...file, contentType: null }).success).toBe(true);
  });

  it('rejects an unknown kind, an unknown key, and a missing path', () => {
    expect(FileResourceSchema.safeParse({ ...file, kind: 'symlink' }).success).toBe(false);
    expect(FileResourceSchema.safeParse({ ...file, storageKey: 'x' }).success).toBe(false);
    const withoutPath = Object.fromEntries(Object.entries(file).filter(([key]) => key !== 'path'));
    expect(FileResourceSchema.safeParse(withoutPath).success).toBe(false);
  });

  it('rejects a negative or fractional size, an epoch-number timestamp, and an empty id', () => {
    expect(FileResourceSchema.safeParse({ ...file, sizeBytes: -1 }).success).toBe(false);
    expect(FileResourceSchema.safeParse({ ...file, sizeBytes: 1.5 }).success).toBe(false);
    expect(FileResourceSchema.safeParse({ ...file, lastModified: 1_700_000_000 }).success).toBe(
      false,
    );
    expect(FileResourceSchema.safeParse({ ...file, id: '' }).success).toBe(false);
  });

  it('publishes the kinds and bounds the routes enforce', () => {
    expect([...FILE_KINDS]).toEqual(['file', 'folder']);
    expect(MAX_UPLOAD_BYTES).toBe(67_108_864);
    expect(MAX_SUBTREE_OBJECTS).toBe(500);
    expect(FILES_PROBLEM_CODES.file_not_found).toBe(404);
    expect(FILES_PROBLEM_CODES.folder_not_empty).toBe(409);
    expect(FILES_PROBLEM_CODES.subtree_too_large).toBe(413);
  });
});

describe('response envelopes', () => {
  it('reads the item, the list, and refuses a bare item where an envelope is due', () => {
    expect(FileResponseSchema.safeParse({ file }).success).toBe(true);
    expect(FileResponseSchema.safeParse(file).success).toBe(false);
    expect(FileListResponseSchema.safeParse({ files: [file, folder] }).success).toBe(true);
    expect(FileListResponseSchema.safeParse({ files: [file], nextCursor: null }).success).toBe(
      false,
    );
  });

  it('reads every move outcome the route can answer, and nothing in between', () => {
    expect(MoveFileResponseSchema.safeParse({ file }).success).toBe(true);
    expect(SubtreeMoveOutcomeSchema.safeParse({ status: 'ok', moved: 3 }).success).toBe(true);
    expect(
      SubtreeMoveOutcomeSchema.safeParse({ status: 'partial', moved: 2, total: 3 }).success,
    ).toBe(true);
    expect(
      SubtreeMoveOutcomeSchema.safeParse({
        status: 'partial',
        moved: 3,
        total: 3,
        remaining: ['a/x.txt'],
      }).success,
    ).toBe(true);
    expect(SubtreeMoveOutcomeSchema.safeParse({ status: 'partial', moved: 2 }).success).toBe(false);
    expect(SubtreeMoveOutcomeSchema.safeParse({ status: 'ok', moved: -1 }).success).toBe(false);
    expect(SubtreeMoveOutcomeSchema.safeParse({ status: 'ok', moved: 1, total: 1 }).success).toBe(
      false,
    );
    expect(MoveFileResponseSchema.safeParse({ status: 'done' }).success).toBe(false);
  });

  it('reads the delete outcomes and the empty 204', () => {
    expect(RemoveFileResponseSchema.safeParse(null).success).toBe(true);
    expect(
      SubtreeDeleteOutcomeSchema.safeParse({ status: 'ok', deleted: ['a/x.txt'] }).success,
    ).toBe(true);
    expect(
      SubtreeDeleteOutcomeSchema.safeParse({ status: 'partial', deleted: [], remaining: ['a/y'] })
        .success,
    ).toBe(true);
    expect(SubtreeDeleteOutcomeSchema.safeParse({ status: 'partial', deleted: [] }).success).toBe(
      false,
    );
    expect(RemoveFileResponseSchema.safeParse({ status: 'ok' }).success).toBe(false);
  });
});

describe('presigned URL schemas', () => {
  it('accepts a bounded upload request and refuses the rest', () => {
    const ok = { contentType: 'text/plain', sizeBytes: 5, ttlSeconds: 300 };
    expect(CreateUploadUrlRequestSchema.safeParse(ok).success).toBe(true);
    expect(CreateUploadUrlRequestSchema.safeParse({ sizeBytes: 0 }).success).toBe(true);
    for (const large of [MAX_UPLOAD_BYTES + 1, SIGNED_UPLOAD_HARD_MAX_BYTES]) {
      expect(CreateUploadUrlRequestSchema.safeParse({ ...ok, sizeBytes: large }).success).toBe(
        true,
      );
    }
    for (const bad of [
      { ...ok, extra: 1 },
      { ...ok, sizeBytes: SIGNED_UPLOAD_HARD_MAX_BYTES + 1 },
      { ...ok, sizeBytes: -1 },
      { ...ok, ttlSeconds: 59 },
      { ...ok, ttlSeconds: 901 },
      { contentType: 'text/plain' },
    ]) {
      expect(CreateUploadUrlRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('bounds the download ttl and refuses unknown keys', () => {
    expect(CreateDownloadUrlRequestSchema.safeParse({}).success).toBe(true);
    expect(CreateDownloadUrlRequestSchema.safeParse({ ttlSeconds: 900 }).success).toBe(true);
    expect(CreateDownloadUrlRequestSchema.safeParse({ ttlSeconds: 901 }).success).toBe(false);
    expect(CreateDownloadUrlRequestSchema.safeParse({ sizeBytes: 1 }).success).toBe(false);
  });

  it('requires an absolute http(s) url and a closed shape in the response', () => {
    const ok = {
      url: 'https://bucket.example/o?sig=1',
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      expiresAt: '2026-10-18T12:05:00.000Z',
      path: 'a.txt',
    };
    expect(PresignedUrlSchema.safeParse(ok).success).toBe(true);
    expect(PresignedUrlSchema.safeParse({ ...ok, url: 'not a url' }).success).toBe(false);
    expect(PresignedUrlSchema.safeParse({ ...ok, url: 'file:///etc/passwd' }).success).toBe(false);
    expect(PresignedUrlSchema.safeParse({ ...ok, method: 'DELETE' }).success).toBe(false);
    expect(PresignedUrlSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(FILES_PROBLEM_CODES.direct_transfer_unsupported).toBe(501);
  });
});

describe('file search schemas', () => {
  it('trims q, defaults and coerces limit, and keeps the bounds the route enforces', () => {
    expect(FileSearchQuerySchema.parse({ q: '  保守手順 ' })).toEqual({
      q: '保守手順',
      limit: DEFAULT_SEARCH_LIMIT,
    });
    expect(FileSearchQuerySchema.parse({ q: 'a', limit: '50' }).limit).toBe(MAX_SEARCH_LIMIT);
    expect(FileSearchQuerySchema.safeParse({ q: 'x'.repeat(MAX_SEARCH_QUERY_CHARS) }).success).toBe(
      true,
    );
    expect(FILES_PROBLEM_CODES.invalid_search_query).toBe(400);
  });

  it('refuses a missing, blank or oversized q, a bad limit, and an unknown parameter', () => {
    for (const bad of [
      {},
      { q: '   ' },
      { q: 'x'.repeat(MAX_SEARCH_QUERY_CHARS + 1) },
      { q: 'a', limit: '0' },
      { q: 'a', limit: String(MAX_SEARCH_LIMIT + 1) },
      { q: 'a', limit: '1.5' },
      { q: 'a', path: 'manuals' },
    ]) {
      expect(FileSearchQuerySchema.safeParse(bad).success).toBe(false);
    }
  });

  it('reads a hit with or without a page, and refuses page 0, a negative score and extra keys', () => {
    const hit = { path: 'manuals/a.pdf', page: 3, snippet: '…保守手順…', score: 0.5 };
    expect(FileSearchHitSchema.safeParse(hit).success).toBe(true);
    expect(FileSearchHitSchema.safeParse({ ...hit, page: null }).success).toBe(true);
    expect(FileSearchHitSchema.safeParse({ ...hit, page: 0 }).success).toBe(false);
    expect(FileSearchHitSchema.safeParse({ ...hit, score: -1 }).success).toBe(false);
    expect(FileSearchHitSchema.safeParse({ ...hit, fileId: 'x' }).success).toBe(false);
    expect(FileSearchResponseSchema.safeParse({ hits: [hit], pending: 0 }).success).toBe(true);
    expect(FileSearchResponseSchema.safeParse({ hits: [hit] }).success).toBe(false);
    expect(FileSearchResponseSchema.safeParse({ hits: [], pending: -1 }).success).toBe(false);
  });
});
