/**
 * Browsing a storage connection through the route: the folders it lists and the prefixes it refuses
 * (the storage design, §05 and §06 Phase 5).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { StorageConnectionBrowseResponseSchema } from '@indx-workspace/contracts/storage-connections';
import { openConnectionStore } from '@agent-workspace/core/storage';

import {
  audits,
  connect,
  fileRoot,
  reach,
  useStorageConnectionRoutes,
} from './handlers.test-support';
import {
  browsedPaths,
  browseBothWays,
  connectFolder,
  REPOSITORY_KINDS,
  seedFolder,
  useLifecycleRepository,
  type RepositoryKind,
} from './handlers.lifecycle.test-support';

useStorageConnectionRoutes();

function registerListingTests(kind: RepositoryKind): void {
  // @story US-STO-12
  it('[US-STO-12][api][sdk] a file:// connection lists and reads the files already in the folder', async () => {
    const id = await connectFolder(`ondisk-${kind}`);
    const response = await reach('browse', id, '?prefix=reports');
    expect(response.status).toBe(200);
    const page = StorageConnectionBrowseResponseSchema.parse(await response.json());
    expect(page.entries.map((entry) => entry.path)).toEqual(['reports/2026', 'reports/a.txt']);
    expect(page.entries.find((entry) => entry.path === 'reports/a.txt')).toMatchObject({
      size: 'reports/a.txt'.length,
    });
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] folder names with a space list their files', async () => {
    const id = await connectFolder(`spaces-${kind}`);
    seedFolder(path.join(fileRoot, `spaces-${kind}`), ['reports/Q3 reports/n.txt']);
    expect(await browsedPaths(await reach('browse', id, '?prefix=reports%2FQ3%20reports'))).toEqual(
      ['reports/Q3 reports/n.txt'],
    );
  });
}

function registerPrefixRefusalTests(kind: RepositoryKind): void {
  // @story US-STO-12
  it('[US-STO-12][api][sdk] browse is limited to allowed folders', async () => {
    const id = await connectFolder(`folders-${kind}`);
    expect(await browsedPaths(await reach('browse', id, '?prefix=reports'))).toEqual([
      'reports/2026',
      'reports/a.txt',
    ]);
    expect(await browsedPaths(await reach('browse', id, '?prefix=reports/'))).toEqual([
      'reports/2026',
      'reports/a.txt',
    ]);
    expect(await browsedPaths(await reach('browse', id, '?prefix=reports/2026'))).toEqual([
      'reports/2026/b.txt',
    ]);
    expect(await browsedPaths(await reach('browse', id))).toEqual(['reports']);

    const refused = [
      'reports-old',
      'secret',
      'reports/..',
      '..',
      '%2e%2e',
      'reports/%2e%2e',
      'reports%2F..%2Fsecret',
      '/reports',
      'reports//2026',
      // The prefix is decoded exactly once, then checked.
      'reports/%2e%2e/secret',
      '%2e',
      'reports%2f..%2fsecret',
      'reports%5c..',
      'reports%00',
      '%2freports',
      '%252e%252e',
      'reports/%252e%252e',
      '%E0%A4%A',
      'reports/%E0%A4%A',
    ];
    for (const prefix of refused) {
      for (const response of await browseBothWays(id, `?prefix=${prefix}`)) {
        expect(response.status, prefix).toBe(403);
        const text = await response.text();
        expect(JSON.parse(text), prefix).toMatchObject({
          error: { code: 'storage_connection_prefix_not_allowed' },
        });
        expect(text).not.toContain('d.txt');
      }
    }
    expect(audits).toHaveLength(1);
  });
}

function registerEncodedNameTests(kind: RepositoryKind): void {
  // @story US-STO-12
  it('[US-STO-12][api][sdk] a folder named with a space, an accent, a plus or an ampersand lists as the server serves it', async () => {
    const name = `names-${kind}`;
    const dir = path.join(fileRoot, name);
    mkdirSync(dir);
    // Through the store the product opens, so the seed lands wherever that store reads.
    const objects = await openConnectionStore(
      pathToFileURL(dir).href,
      { provider: 'file' },
      { writable: true, fileRoots: [fileRoot], egress: { production: false, allowHosts: [] } },
    );
    const keys = [
      'reports/Q3 drafts/z.txt',
      'reports/Q3+drafts/plus.txt',
      'reports/café/e.txt',
      'reports/a&b/amp.txt',
    ];
    for (const key of keys) await objects.write(key, new TextEncoder().encode(key), {});
    const id = await connect({
      name,
      url: pathToFileURL(dir).href,
      allowedPrefixes: ['reports'],
    });

    // What the SDK sends (`encodeURIComponent`), and the spellings a person types by hand.
    const listed: Record<string, string> = {
      'reports%2FQ3%20drafts': 'reports/Q3 drafts/z.txt',
      'reports/Q3%20drafts': 'reports/Q3 drafts/z.txt',
      'reports%2FQ3+drafts': 'reports/Q3 drafts/z.txt',
      'reports%2FQ3%2Bdrafts': 'reports/Q3+drafts/plus.txt',
      'reports%2Fcaf%C3%A9': 'reports/café/e.txt',
      'reports%2Fa%26b': 'reports/a&b/amp.txt',
    };
    for (const [prefix, file] of Object.entries(listed)) {
      for (const response of await browseBothWays(id, `?prefix=${prefix}`)) {
        expect(await browsedPaths(response), prefix).toEqual([file]);
      }
    }
  });
}

function registerCursorTests(kind: RepositoryKind): void {
  // @story US-STO-12
  it('[US-STO-12][api][sdk] a tampered cursor never lists outside the prefix', async () => {
    const id = await connectFolder(`cursors-${kind}`);
    const cursors = [
      'file:../secret/d.txt',
      'file:secret/d.txt',
      'file:reports-old/c.txt',
      'folder:',
      'file:',
      'no-kind',
      'file:\u0000',
    ];
    for (const cursor of cursors) {
      const response = await reach(
        'browse',
        id,
        `?prefix=reports&cursor=${encodeURIComponent(cursor)}`,
      );
      for (const found of await browsedPaths(response)) {
        expect(found, cursor).toMatch(/^reports\//u);
      }
    }
  });
}

describe.each(REPOSITORY_KINDS)('storage connection lifecycle over the %s repository', (kind) => {
  useLifecycleRepository(kind);
  describe('browse', () => {
    registerListingTests(kind);
    registerPrefixRefusalTests(kind);
    registerEncodedNameTests(kind);
    registerCursorTests(kind);
  });
});
