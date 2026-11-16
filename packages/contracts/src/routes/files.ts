import type { ApiRoute } from './definition.js';
import { BINARY, created, json, NONE, ok } from './definition.js';
export const filesRoutes: readonly ApiRoute[] = [
  // §5.6 — files
  {
    method: 'GET',
    path: '/api/files',
    operationId: 'files.list',
    tag: 'files',
    feature: 'files',
    summary: 'List files and folders',
    success: ok(json('FileListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/files',
    operationId: 'files.upload',
    tag: 'files',
    feature: 'files',
    summary: 'Upload a file (bytes, path in `x-file-path`) or create a folder (`x-folder-path`)',
    request: BINARY,
    success: [
      { status: 200, body: json('FileResponseSchema') },
      { status: 201, body: json('FileResponseSchema') },
    ],
  },

  {
    method: 'GET',
    path: '/api/files/search',
    operationId: 'files.search',
    tag: 'files',
    feature: 'files',
    summary:
      'Search the text of workspace files (`q`, `limit`): path, page and snippet per hit; `pending` counts files not yet searchable',
    success: ok(json('FileSearchResponseSchema')),
  },

  {
    method: 'GET',
    path: '/api/files/:id',
    operationId: 'files.download',
    tag: 'files',
    feature: 'files',
    summary: "Download a file's bytes (the id is the base64url path)",
    success: ok(BINARY),
  },

  {
    method: 'PATCH',
    path: '/api/files/:id',
    operationId: 'files.move',
    tag: 'files',
    feature: 'files',
    summary: 'Move or rename a file or folder',
    request: json('MoveFileRequestSchema'),
    success: ok(json('MoveFileResponseSchema')),
  },

  {
    method: 'DELETE',
    path: '/api/files/:id',
    operationId: 'files.remove',
    tag: 'files',
    feature: 'files',
    summary: 'Delete a file or a folder subtree',
    success: [
      { status: 200, body: json('RemoveFileResponseSchema') },
      { status: 204, body: NONE },
    ],
  },

  {
    method: 'POST',
    path: '/api/files/:id/upload-urls',
    operationId: 'files.createUploadUrl',
    tag: 'files',
    feature: 'files',
    summary:
      'Mint a short-lived PUT URL on the object store, so the holder uploads without a relay',
    request: json('CreateUploadUrlRequestSchema'),
    success: created(json('PresignedUrlSchema')),
  },

  {
    method: 'POST',
    path: '/api/files/:id/upload-complete',
    operationId: 'files.completeUpload',
    tag: 'files',
    feature: 'files',
    summary: 'Verify the object a signed PUT wrote and mark the file ready',
    success: ok(json('FileResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/files/:id/download-urls',
    operationId: 'files.createDownloadUrl',
    tag: 'files',
    feature: 'files',
    summary:
      'Mint a short-lived GET URL on the object store, so the holder downloads without a relay',
    request: json('CreateDownloadUrlRequestSchema'),
    success: created(json('PresignedUrlSchema')),
  },
];
