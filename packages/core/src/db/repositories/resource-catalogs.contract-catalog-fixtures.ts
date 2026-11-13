import { type CatalogFile, type CatalogPort, type ReserveOutcome } from './resource-catalogs.js';
export const upload = async (
  catalog: CatalogPort,
  owner: string,
  path: string,
  sizeBytes = 1,
): Promise<CatalogFile> => {
  const reserved = await catalog.reserve(path, {
    objectId: crypto.randomUUID(),
    ownerPrincipalId: owner,
    sizeBytes,
    contentType: null,
  });
  if (reserved.kind !== 'reserved') throw new Error(`${path} was already taken`);
  const done = await catalog.confirm(reserved.row, { sizeBytes, contentType: 'text/plain' });
  if (done === null) throw new Error(`${path} vanished before confirm`);
  return done.row;
};

export const replace = async (
  catalog: CatalogPort,
  owner: string,
  path: string,
): Promise<ReserveOutcome> =>
  catalog.reserve(path, {
    ownerPrincipalId: owner,
    sizeBytes: 1,
    contentType: null,
    objectId: crypto.randomUUID(),
  });

export const paths = (rows: readonly CatalogFile[]) => rows.map((row) => row.path);

export const pending = async (catalog: CatalogPort, owner: string, path: string) => {
  const reserved = await catalog.reserve(path, {
    objectId: crypto.randomUUID(),
    ownerPrincipalId: owner,
    sizeBytes: 5,
    contentType: null,
  });
  if (reserved.kind !== 'reserved') throw new Error(`${path} was already taken`);
  return reserved.row;
};

/** PostgreSQL's CHECK violation, as the driver error's cause carries it. */
export const checkViolation = (constraint: string) => ({ cause: { code: '23514', constraint } });

export const signed = (catalog: CatalogPort, owner: string, path: string, objectId: string) =>
  catalog.reserve(path, {
    ownerPrincipalId: owner,
    sizeBytes: 5,
    contentType: null,
    objectId,
    uploadMode: 'signed',
  });
