import type { ApiRoute } from './definition.js';
import { created, json, NO_CONTENT, ok } from './definition.js';
export const storageConnectionRoutes: readonly ApiRoute[] = [
  // The storage design §05 — connected buckets and folders
  {
    method: 'GET',
    path: '/api/storage-connections',
    operationId: 'storage.connections.list',
    tag: 'storage-connections',
    feature: 'core',
    summary: 'List the storage connections of the workspace',
    success: ok(json('StorageConnectionListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/storage-connections',
    operationId: 'storage.connections.create',
    tag: 'storage-connections',
    feature: 'core',
    summary: 'Connect an S3 bucket or an operator folder, read-only by default',
    request: json('CreateStorageConnectionInputSchema'),
    success: created(json('StorageConnectionResourceSchema')),
  },

  {
    method: 'GET',
    path: '/api/storage-connections/:id',
    operationId: 'storage.connections.get',
    tag: 'storage-connections',
    feature: 'core',
    summary: 'Read one storage connection',
    success: ok(json('StorageConnectionResourceSchema')),
  },

  {
    method: 'PATCH',
    path: '/api/storage-connections/:id',
    operationId: 'storage.connections.update',
    tag: 'storage-connections',
    feature: 'core',
    summary: 'Rename a storage connection or change its URL, allowed prefixes or write access',
    request: json('UpdateStorageConnectionPatchSchema'),
    success: ok(json('StorageConnectionResourceSchema')),
  },

  {
    method: 'PUT',
    path: '/api/storage-connections/:id/credential',
    operationId: 'storage.connections.rotate',
    tag: 'storage-connections',
    feature: 'core',
    summary: 'Replace the credential of a storage connection (the old value is never returned)',
    request: json('StorageConnectionCredentialSchema'),
    success: ok(json('StorageConnectionResourceSchema')),
  },

  {
    method: 'POST',
    path: '/api/storage-connections/:id/test',
    operationId: 'storage.connections.test',
    tag: 'storage-connections',
    feature: 'core',
    summary: 'Open a storage connection and list one page of an allowed folder',
    success: ok(json('StorageConnectionTestOutcomeSchema')),
  },

  {
    method: 'GET',
    path: '/api/storage-connections/:id/browse',
    operationId: 'storage.connections.browse',
    tag: 'storage-connections',
    feature: 'core',
    summary: 'List a folder of a storage connection inside its allowed prefixes (?prefix=&cursor=)',
    success: ok(json('StorageConnectionBrowseResponseSchema')),
  },

  {
    method: 'DELETE',
    path: '/api/storage-connections/:id',
    operationId: 'storage.connections.delete',
    tag: 'storage-connections',
    feature: 'core',
    summary: 'Delete a storage connection and its credential',
    success: NO_CONTENT,
  },
];
