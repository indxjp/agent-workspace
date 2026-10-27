/**
 * STO-503-STORAGE-CONNECTIONS-1690 · connect a bucket or a folder — issue #1690, the storage design §05.
 *
 * Spec §34 prints no storage-connection route, so each carries a section 16 mandate: §16 keeps file
 * bytes in object storage, and a workspace chooses which store that is by connecting it here. A
 * credential is held in the secret store and never returned.
 */
import type { RouteDeclaration } from '../inventory-support.js';

export const routes: readonly RouteDeclaration[] = [
  {
    method: 'GET',
    path: '/api/storage-connections',
    owner: 'STO-503-STORAGE-CONNECTIONS-1690',
    landed: true,
    mandate: {
      section: '16',
      because:
        'Section 16 keeps file bytes in object storage; a workspace connects the bucket or folder it means to use here, with the credential held in the secret store and never returned.',
    },
  },
  {
    method: 'POST',
    path: '/api/storage-connections',
    owner: 'STO-503-STORAGE-CONNECTIONS-1690',
    landed: true,
    mandate: {
      section: '16',
      because:
        'Section 16 keeps file bytes in object storage; a workspace connects the bucket or folder it means to use here, with the credential held in the secret store and never returned.',
    },
  },
  {
    method: 'GET',
    path: '/api/storage-connections/:id',
    owner: 'STO-503-STORAGE-CONNECTIONS-1690',
    landed: true,
    mandate: {
      section: '16',
      because:
        'Section 16 keeps file bytes in object storage; a workspace connects the bucket or folder it means to use here, with the credential held in the secret store and never returned.',
    },
  },
  {
    method: 'PATCH',
    path: '/api/storage-connections/:id',
    owner: 'STO-503-STORAGE-CONNECTIONS-1690',
    landed: true,
    mandate: {
      section: '16',
      because:
        'Section 16 keeps file bytes in object storage; a workspace renames a connection or changes its URL, allowed prefixes and write access here, and the credential is never part of the change.',
    },
  },
  {
    method: 'PUT',
    path: '/api/storage-connections/:id/credential',
    owner: 'STO-503-STORAGE-CONNECTIONS-1690',
    landed: true,
    mandate: {
      section: '16',
      because:
        'Section 16 keeps file bytes in object storage; a workspace rotates the credential of a connection here, held in the secret store, and the old value is never returned.',
    },
  },
  {
    method: 'DELETE',
    path: '/api/storage-connections/:id',
    owner: 'STO-503-STORAGE-CONNECTIONS-1690',
    landed: true,
    mandate: {
      section: '16',
      because:
        'Section 16 keeps file bytes in object storage; a workspace disconnects a bucket or folder here, and its credential is removed with it.',
    },
  },
  {
    method: 'POST',
    path: '/api/storage-connections/:id/test',
    owner: 'STO-503-STORAGE-CONNECTIONS-1690',
    landed: true,
    mandate: {
      section: '16',
      because:
        'Section 16 keeps file bytes in object storage; a workspace checks here that a connected bucket or folder answers, and the credential and the provider reply are never returned.',
    },
  },
  {
    method: 'GET',
    path: '/api/storage-connections/:id/browse',
    owner: 'STO-503-STORAGE-CONNECTIONS-1690',
    landed: true,
    mandate: {
      section: '16',
      because:
        'Section 16 keeps file bytes in object storage; a workspace lists the folders of a connected bucket here, limited to the connection allowed prefixes.',
    },
  },
];
