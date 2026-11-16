/**
 * Test fixtures: put a ready file or folder into a catalog through its own two-step write, so a test
 * row is exactly what the storage service would leave (the storage design, §04). No bytes are
 * written; a test that reads them writes them under {@link CatalogFile.storageKey}'s object name.
 */
import { randomUUID } from 'node:crypto';

import type { FileKind } from '../schema/files.js';
import type { CatalogFile, CatalogPort } from './resource-catalogs.js';

/** What a fixture row is made of; a folder takes no size or content type. */
export interface CatalogFileFixture {
  readonly path: string;
  readonly kind?: FileKind;
  readonly sizeBytes?: number;
  readonly contentType?: string | null;
  readonly ownerPrincipalId: string;
  readonly createdBy?: string | null;
  readonly sha256?: string | null;
}

/**
 * A ready row at `path`. A file gets a new object id; over a ready file it is a replacement, so the
 * returned row has a new id and the old one is `deleting`. A folder over any row is that row.
 */
export async function seedCatalogFile(
  catalog: Pick<CatalogPort, 'reserve' | 'confirm' | 'createFolder'>,
  input: CatalogFileFixture,
): Promise<CatalogFile> {
  const owner = { ownerPrincipalId: input.ownerPrincipalId, createdBy: input.createdBy ?? null };
  if (input.kind === 'folder') return (await catalog.createFolder(input.path, owner)).row;
  const sizeBytes = input.sizeBytes ?? 0;
  const contentType = input.contentType ?? null;
  const reserved = await catalog.reserve(input.path, {
    ...owner,
    objectId: randomUUID(),
    sizeBytes,
    contentType,
  });
  if (reserved.kind === 'taken') {
    throw new Error(`a fixture file cannot be put at ${input.path}: another row holds it`);
  }
  const confirmed = await catalog.confirm(reserved.row, {
    sizeBytes,
    contentType,
    sha256: input.sha256 ?? null,
  });
  if (confirmed === null) throw new Error(`the fixture file at ${input.path} was not confirmed`);
  return confirmed.row;
}
