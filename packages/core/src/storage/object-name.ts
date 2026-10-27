/**
 * The one function that builds a storage object name (the storage design, §04 "Where files
 * live", §05 "One workspace reads another's files"):
 * `workspaces/<workspace ID>/<area>/<object ID>`, relative to the store root. Both IDs are
 * lowercase UUIDs and the area is one of {@link storageAreas}, so a name cannot contain a
 * separator, a dot segment or a second workspace, whatever the caller passes.
 */
import { storageAreas, type StorageArea } from './storage-areas.js';

import { toObjectKey, UnsafeObjectKeyError } from './key-safety.js';

export { storageAreas, type StorageArea };

declare const objectNameBrand: unique symbol;

/** `workspaces/<workspaceId>/<area>/<objectId>`, relative to the store root. */
export type StorageObjectName = string & { readonly [objectNameBrand]: true };

function isStorageArea(value: string): value is StorageArea {
  return (storageAreas as readonly string[]).includes(value);
}

// Lowercase only: Postgres renders UUIDs in lowercase, and `ABC…`/`abc…` must not be two folders.
// Kept local rather than importing `isUuid` from the contracts barrel, which would widen the
// storage barrel's reviewed package list (`index.test.ts`).
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function assertId(kind: string, value: string): void {
  if (!LOWERCASE_UUID.test(value)) {
    throw new UnsafeObjectKeyError('non-canonical', value, `a ${kind} must be a lowercase UUID`);
  }
}

/** `workspaces/<workspaceId>/` — one workspace's folder. */
export function workspaceFolder(workspaceId: string): string {
  assertId('workspace ID', workspaceId);
  return `workspaces/${workspaceId}/`;
}

export function storageObjectName(
  workspaceId: string,
  area: StorageArea,
  objectId: string,
): StorageObjectName {
  const folder = workspaceFolder(workspaceId);
  if (!isStorageArea(area)) {
    throw new UnsafeObjectKeyError('non-canonical', String(area), 'unknown storage area');
  }
  assertId('object ID', objectId);
  return toObjectKey(`${folder}${area}/${objectId}`) as StorageObjectName;
}

/** Inverse of {@link storageObjectName}, for cleanup and migration: `null` for any other layout. */
export function parseStorageObjectName(
  name: string,
): { workspaceId: string; area: StorageArea; objectId: string } | null {
  const [root, workspaceId, area, objectId, ...rest] = name.split('/');
  if (root !== 'workspaces' || rest.length > 0) return null;
  if (workspaceId === undefined || area === undefined || objectId === undefined) return null;
  if (!isStorageArea(area)) return null;
  try {
    storageObjectName(workspaceId, area, objectId);
  } catch (error) {
    if (error instanceof UnsafeObjectKeyError) return null;
    throw error;
  }
  return { workspaceId, area, objectId };
}

const hex = (value: number, width: number): string => value.toString(16).padStart(width, '0');

let lastMs = 0;
let sequence = 0;

/**
 * A UUID v7 (RFC 9562; time-ordered, so the cleanup job can read an age from it). Ids minted in
 * the same millisecond are ordered by a 12-bit counter in `rand_a`.
 */
// ponytail: the counter is per process; ids from two replicas in one millisecond are not ordered.
export function newObjectId(): string {
  const now = Date.now();
  if (now > lastMs) {
    lastMs = now;
    sequence = 0;
  } else if (++sequence > 0xfff) {
    lastMs += 1;
    sequence = 0;
  }
  const random = crypto.getRandomValues(new Uint8Array(8));
  random[0] = 0x80 | ((random[0] ?? 0) & 0x3f);
  const tail = Array.from(random, (byte) => hex(byte, 2)).join('');
  const time = hex(lastMs, 12);
  return `${time.slice(0, 8)}-${time.slice(8)}-7${hex(sequence, 3)}-${tail.slice(0, 4)}-${tail.slice(4)}`;
}
