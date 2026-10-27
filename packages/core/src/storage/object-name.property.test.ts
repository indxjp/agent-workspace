/**
 * Property tests for the one function that builds storage object names (the storage design, §04
 * "Where files live" and §05 "One workspace reads another's files"): whatever it is given, a
 * name is either refused or stays inside `workspaces/<workspace>/<area>/`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { UnsafeObjectKeyError } from './key-safety.js';
import {
  newObjectId,
  parseStorageObjectName,
  storageAreas,
  storageObjectName,
  workspaceFolder,
  type StorageArea,
} from './object-name.js';

const RUNS = { numRuns: 1_000 };

const hostile = fc.constantFrom('', '..', '../x', 'a/b', '%2e%2e', '.', '/', 'a\\b', 'x\u0000y');
const idLike = fc.oneof(fc.uuid(), fc.string(), hostile);
const areaLike = fc.oneof(fc.constantFrom(...storageAreas), fc.string(), hostile);
const validId = fc.uuid().map((id) => id.toLowerCase());
const validArea = fc.constantFrom(...storageAreas);

describe('storage object names', () => {
  it('object names never leave their workspace', () => {
    fc.assert(
      fc.property(idLike, areaLike, idLike, (workspaceId, area, objectId) => {
        let name: string;
        try {
          name = storageObjectName(workspaceId, area as StorageArea, objectId);
        } catch (error) {
          expect(error).toBeInstanceOf(UnsafeObjectKeyError);
          return;
        }
        expect(name.startsWith(`workspaces/${workspaceId}/${area}/`)).toBe(true);
        const segments = name.split('/');
        expect(segments).toHaveLength(4);
        expect(segments).not.toContain('..');
        expect(segments[1]).toBe(workspaceId);
      }),
      RUNS,
    );
  });

  it('parse is the inverse of build', () => {
    fc.assert(
      fc.property(validId, validArea, validId, (workspaceId, area, objectId) => {
        const name = storageObjectName(workspaceId, area, objectId);
        expect(parseStorageObjectName(name)).toEqual({ workspaceId, area, objectId });
      }),
      RUNS,
    );
  });

  it('parse refuses anything outside the layout', () => {
    const ws = newObjectId();
    const id = newObjectId();
    for (const name of [
      `files/workspaces/${ws}/a.txt`,
      'reports/q3.pdf',
      '',
      `workspaces/${ws}/files/${id}/extra`,
      `workspaces/${ws}/unknown/${id}`,
      `workspaces/${ws}/files/${id.toUpperCase()}`,
      `workspaces/${ws.toUpperCase()}/files/${id}`,
      `workspaces/${ws}/files/..`,
    ]) {
      expect(parseStorageObjectName(name), name).toBeNull();
    }
  });

  it('ids that are not UUIDs are refused', () => {
    const id = newObjectId();
    for (const bad of ['', 'abc', '..', 'a/b', id.toUpperCase(), `${id}/x`]) {
      expect(() => workspaceFolder(bad), bad).toThrow(UnsafeObjectKeyError);
      expect(() => storageObjectName(bad, 'files', id), bad).toThrow(UnsafeObjectKeyError);
      expect(() => storageObjectName(id, 'files', bad), bad).toThrow(UnsafeObjectKeyError);
    }
    expect(() => storageObjectName(id, 'logs' as StorageArea, id)).toThrow(UnsafeObjectKeyError);
  });

  it('object ids are time-ordered', () => {
    const ids = Array.from({ length: 5_000 }, () => newObjectId());
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });
});
