import { type CatalogPort } from '@agent-workspace/core/db';
import {
  createInMemoryObjectStore,
  storageObjectName,
  type ObjectStore,
  type StorageArea,
} from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';

import { CLEANUP_MIN_AGE_MS, runCleanupPass } from './cleanup';

import type { CleanupFixture } from './cleanup.fixture.test-support';
export async function createCleanupHarness(setup: () => Promise<CleanupFixture>) {
  const fixture = await setup();
  const objects = createInMemoryObjectStore();
  const lines: { message: string; fields: unknown }[] = [];
  const log: Logger = {
    info: (message, fields) => lines.push({ message, fields }),
    warn: (message, fields) => lines.push({ message, fields }),
    error: (message, fields) => lines.push({ message, fields }),
    child: () => log,
  };
  const owners = new Map<string, string>();
  const known = async () => {
    const created = await fixture.workspace();
    owners.set(created.id, created.principalId);
    return created;
  };
  // The objects were just written; the clock is far enough ahead for them to be old enough.
  const later = () => new Date(Date.now() + 2 * CLEANUP_MIN_AGE_MS);
  const run = (mode: 'report' | 'delete', options: RunOptions = {}) =>
    runCleanupPass({
      objects: options.objects ?? objects,
      catalogs: options.catalogs ?? fixture.catalog,
      sessionState: fixture.sessionState,
      workspaceIds: () => Promise.resolve([...owners.keys()]),
      now: options.now ?? later,
      mode,
      log,
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    });
  const newName = (workspaceId: string, objectId: string) =>
    storageObjectName(workspaceId, 'files', objectId);
  /** An object in the new naming, `size` bytes long. */
  const newObject = (workspaceId: string, objectId: string, size = 7) =>
    objects.write(newName(workspaceId, objectId), new Uint8Array(size), { contentType: null });
  const { reserveRow, readyRow } = createCleanupRows(fixture);
  return {
    fixture,
    known,
    newObject,
    newName,
    reserveRow,
    readyRow,
    run,
    lines,
    objects,
  };
}

function createCleanupRows(fixture: CleanupFixture) {
  const reserveRow = async (
    ws: { id: string; principalId: string },
    path: string,
    input: {
      sizeBytes?: number;
      objectId?: string;
      area?: StorageArea;
      uploadMode?: 'relay' | 'signed';
    } = {},
  ) => {
    const catalog = await fixture.catalog(ws.id);
    const reserved = await catalog.reserve(path, {
      ...(input.area === undefined ? {} : { area: input.area }),
      ownerPrincipalId: ws.principalId,
      sizeBytes: input.sizeBytes ?? 0,
      contentType: 'text/plain',
      objectId: input.objectId ?? crypto.randomUUID(),
      ...(input.uploadMode === undefined ? {} : { uploadMode: input.uploadMode }),
    });
    if (reserved.kind !== 'reserved') throw new Error(`${path} was already taken`);
    return reserved.row;
  };
  const readyRow = async (
    ws: { id: string; principalId: string },
    path: string,
    input: { sizeBytes?: number; objectId?: string; area?: StorageArea } = {},
  ) => {
    const row = await reserveRow(ws, path, input);
    const catalog = await fixture.catalog(ws.id);
    const done = await catalog.confirm(row, {
      sizeBytes: row.sizeBytes,
      contentType: 'text/plain',
    });
    if (done === null) throw new Error(`${path} vanished before confirm`);
    return done.row;
  };
  return { reserveRow, readyRow };
}

interface RunOptions {
  readonly pageSize?: number;
  readonly now?: () => Date;
  readonly objects?: ObjectStore;
  readonly catalogs?: (workspaceId: string) => Promise<CatalogPort>;
}
