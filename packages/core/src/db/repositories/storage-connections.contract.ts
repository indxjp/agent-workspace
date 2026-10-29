/**
 * The one storage-connection repository suite (the storage design, §05): the in-memory repository
 * and the PostgreSQL repository both run it, so a rule the database enforces cannot be missing from
 * the double. A fixture owes one repository per workspace (`'a'` and `'b'`, empty and unrelated).
 */
import { describe, expect, it } from 'vitest';

import type {
  CreateStorageConnectionRecordInput,
  StorageConnectionRepository,
} from './storage-connections.js';

export interface StorageConnectionsConformanceFixture {
  readonly repository: (workspace: 'a' | 'b') => StorageConnectionRepository;
}

function input(name: string): CreateStorageConnectionRecordInput {
  return {
    id: crypto.randomUUID(),
    name,
    provider: 's3',
    url: `s3://${name}/exports`,
    allowedPrefixes: ['reports', 'exports/2026'],
    writeAllowed: false,
  };
}

export function describeStorageConnectionsConformance(
  label: string,
  makeFixture: () => Promise<StorageConnectionsConformanceFixture>,
): void {
  describe(`storage connections conformance: ${label}`, () => {
    // @story US-STO-12
    it('[US-STO-12][contract][sdk] a created connection reads back from get and list', async () => {
      const a = (await makeFixture()).repository('a');
      const created = await a.create(input('acme-data'));
      if (created.kind !== 'created') throw new Error('the first connection was refused');
      expect(created.connection).toMatchObject({
        name: 'acme-data',
        provider: 's3',
        allowedPrefixes: ['reports', 'exports/2026'],
        writeAllowed: false,
      });
      await expect(a.get(created.connection.id)).resolves.toEqual(created.connection);
      await expect(a.list()).resolves.toEqual([created.connection]);
    });

    // @story US-STO-12
    it('[US-STO-12][contract][sdk] a name is taken once per workspace', async () => {
      const { repository } = await makeFixture();
      expect((await repository('a').create(input('acme-data'))).kind).toBe('created');
      await expect(repository('a').create(input('acme-data'))).resolves.toEqual({
        kind: 'name-conflict',
        name: 'acme-data',
      });
      expect((await repository('b').create(input('acme-data'))).kind).toBe('created');
    });

    // @story US-STO-12
    it('[US-STO-12][contract][sdk] one workspace never sees the connections of another', async () => {
      const { repository } = await makeFixture();
      const created = await repository('a').create(input('acme-data'));
      if (created.kind !== 'created') throw new Error('the first connection was refused');
      await expect(repository('b').get(created.connection.id)).resolves.toBeNull();
      await expect(repository('b').list()).resolves.toEqual([]);
    });

    // @story US-STO-12
    it('[US-STO-12][contract][sdk] listByNames answers only the named connections of this workspace', async () => {
      const { repository } = await makeFixture();
      const a = repository('a');
      const wanted = await a.create(input('acme-data'));
      const other = await a.create(input('acme-other'));
      if (wanted.kind !== 'created' || other.kind !== 'created') {
        throw new Error('a fixture connection was refused');
      }
      expect((await repository('b').create(input('acme-data'))).kind).toBe('created');
      await expect(a.listByNames(['acme-data', 'missing'])).resolves.toEqual([wanted.connection]);
      await expect(a.listByNames([])).resolves.toEqual([]);
    });

    // @story US-STO-12
    it('[US-STO-12][contract][sdk] an update changes only the fields it names', async () => {
      const a = (await makeFixture()).repository('a');
      const created = await a.create(input('acme-data'));
      if (created.kind !== 'created') throw new Error('the first connection was refused');
      const updated = await a.update(created.connection.id, {
        name: 'acme-renamed',
        writeAllowed: true,
      });
      if (updated.kind !== 'updated') throw new Error('the update was refused');
      expect(updated.connection).toMatchObject({
        id: created.connection.id,
        name: 'acme-renamed',
        url: created.connection.url,
        allowedPrefixes: ['reports', 'exports/2026'],
        writeAllowed: true,
      });
      expect(updated.connection.updatedAt.getTime()).toBeGreaterThanOrEqual(
        created.connection.updatedAt.getTime(),
      );
      await expect(a.get(created.connection.id)).resolves.toEqual(updated.connection);
    });

    // @story US-STO-12
    it('[US-STO-12][contract][sdk] an update cannot take the name of another connection', async () => {
      const a = (await makeFixture()).repository('a');
      await a.create(input('acme-data'));
      const other = await a.create(input('acme-logs'));
      if (other.kind !== 'created') throw new Error('the second connection was refused');
      await expect(a.update(other.connection.id, { name: 'acme-data' })).resolves.toEqual({
        kind: 'name-conflict',
        name: 'acme-data',
      });
      await expect(a.update(other.connection.id, { name: 'acme-logs' })).resolves.toMatchObject({
        kind: 'updated',
      });
    });

    // @story US-STO-12
    it('[US-STO-12][contract][sdk] a delete removes the connection and returns it', async () => {
      const a = (await makeFixture()).repository('a');
      const created = await a.create(input('acme-data'));
      if (created.kind !== 'created') throw new Error('the first connection was refused');
      await expect(a.delete(created.connection.id)).resolves.toEqual(created.connection);
      await expect(a.get(created.connection.id)).resolves.toBeNull();
      await expect(a.delete(created.connection.id)).resolves.toBeNull();
      expect((await a.create(input('acme-data'))).kind).toBe('created');
    });

    // @story US-STO-12
    it('[US-STO-12][contract][sdk] another workspace can neither update nor delete a connection', async () => {
      const { repository } = await makeFixture();
      const created = await repository('a').create(input('acme-data'));
      if (created.kind !== 'created') throw new Error('the first connection was refused');
      const { id } = created.connection;
      await expect(repository('b').update(id, { writeAllowed: true })).resolves.toEqual({
        kind: 'not-found',
      });
      await expect(repository('b').delete(id)).resolves.toBeNull();
      await expect(repository('a').get(id)).resolves.toEqual(created.connection);
    });
  });
}
