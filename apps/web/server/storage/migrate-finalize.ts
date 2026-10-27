/**
 * The last stage of the move off the old object naming (the storage design, §06 "Moving existing
 * files safely", §09): check every object under the new naming, record the pass, and only then
 * delete the old copies. Old copies are deleted last, and only while the latest recorded pass found
 * no row still without an object id and no mismatch. Every step can be repeated: a stopped run is
 * started again and checks again.
 *
 * Only old objects that are accounted for are deleted: the old twin of a row that has moved to the
 * new naming, the old blob of a moved session-state blob, a skill marker whose information is in its
 * column, and an empty-folder marker whose folder is a catalog row. Any other old object (no row ever
 * adopted it) is kept and reported, because deleting it would lose data; the adopt stage gives it a
 * row and the copy stage moves it.
 *
 * No object store call runs inside a database transaction: every catalog call here is one statement.
 */
import {
  storageObjectName,
  type ObjectStoreProviderV2,
  type ObjectStoreV2,
  type StorageArea,
} from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';

import { SKILL_ROWS_ROOT, skillRowFolder } from '../skills/keys';
import { pendingSkillDelete } from '../skills/pending-delete';
import { measure } from './measure';
import type { CatalogSkill, FinalizeBlobCatalog, FinalizeCatalog, MigrationRuns } from './store';

const LIST_LIMIT = 1000;
const SAMPLE_SIZE = 10;
const EMPTY_FOLDER_MARKER = '.agent-workspace-empty-folder';
const LEGACY_AREAS = ['files', 'skills', 'session-state'] as const;

export interface FinalizeDependencies {
  /** The shared root, new naming. */
  readonly objects: ObjectStoreV2;
  /** The old store of each area; an area without one has nothing to delete. */
  readonly legacy: Partial<Readonly<Record<StorageArea, ObjectStoreProviderV2>>>;
  readonly catalog: (workspaceId: string) => Promise<FinalizeCatalog>;
  /** The session-state blob rows of a workspace; absent when this deployment has none. */
  readonly blobs?: (workspaceId: string) => Promise<FinalizeBlobCatalog>;
  readonly workspaceIds: () => Promise<readonly string[]>;
  readonly runs: MigrationRuns;
  readonly log: Logger;
  /** Rows and objects per page. Defaults to {@link LIST_LIMIT}. */
  readonly pageSize?: number;
}

export interface VerifyResult {
  /** Objects whose size and checksum were checked. */
  readonly rowsChecked: number;
  /** Rows still without an object id. */
  readonly legacyRows: number;
  readonly mismatches: number;
  /** The new object names that failed, at most {@link SAMPLE_SIZE}. */
  readonly mismatched: readonly string[];
}

export interface DeleteResult {
  /** Why nothing was deleted, or `null` when the delete ran. */
  readonly refused: 'no-pass' | 'unclean-pass' | 'legacy-rows' | null;
  readonly deleted: number;
  /** Old objects no row accounts for, kept. */
  readonly unaccounted: number;
  /** `<area>:<workspace id>:<key>` of the first of them. */
  readonly unaccountedSample: readonly string[];
}

export interface FinalizeReport {
  readonly verify: VerifyResult;
  readonly outcome: 'deleted' | 'blocked';
  readonly delete: DeleteResult | null;
}

/** Does the object at `name` have the size and the streamed SHA-256 its row records? */
async function intact(
  objects: ObjectStoreV2,
  name: string,
  row: { readonly sizeBytes: number; readonly sha256: string | null },
): Promise<boolean> {
  // A row with no checksum cannot be proven: it blocks the delete until it has one.
  if (row.sha256 === null) return false;
  const head = await objects.head(name);
  if (head === null || head.sizeBytes !== row.sizeBytes) return false;
  const stream = await objects.read(name);
  if (stream === null) return false;
  const measured = measure(Number.MAX_SAFE_INTEGER);
  await stream.body.pipeThrough(measured.stream).pipeTo(new WritableStream());
  const found = measured.result();
  return found.sizeBytes === row.sizeBytes && found.sha256 === row.sha256;
}

/** Rows of one workspace still without an object id. */
async function countLegacy(deps: FinalizeDependencies, workspaceId: string): Promise<number> {
  const files = await (await deps.catalog(workspaceId)).countLegacyFiles();
  const blobs =
    deps.blobs === undefined ? 0 : await (await deps.blobs(workspaceId)).countLegacyBlobs();
  return files + blobs;
}

/**
 * Check every row of every area that has an object id: its object must exist, be as large as the row
 * says, and hash to the row's checksum, read as a stream. Stops at the first mismatch. A failing
 * store or catalog call throws and nothing is recorded.
 */
// @story US-STO-13
// storage-bridge(#1699): old object naming
export async function verifyAll(deps: FinalizeDependencies): Promise<VerifyResult> {
  let rowsChecked = 0;
  let legacyRows = 0;
  const mismatched: string[] = [];
  const check = async (name: string, row: Parameters<typeof intact>[2]): Promise<void> => {
    rowsChecked += 1;
    if (rowsChecked % 100 === 0) {
      deps.log.info(JSON.stringify({ event: 'storage-migrate', mode: 'finalize', rowsChecked }));
    }
    if (!(await intact(deps.objects, name, row))) mismatched.push(name);
  };

  for (const workspaceId of await deps.workspaceIds()) {
    const catalog = await deps.catalog(workspaceId);
    let cursor: string | undefined;
    do {
      const page = await catalog.list('', {
        limit: deps.pageSize ?? LIST_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const row of page.rows) {
        if (mismatched.length > 0) break;
        if (row.kind !== 'file' || (row.objectId ?? null) === null) continue;
        const name = storageObjectName(workspaceId, row.area ?? 'files', row.objectId ?? '');
        await check(name, { sizeBytes: row.sizeBytes, sha256: row.sha256 ?? null });
      }
      cursor = mismatched.length > 0 ? undefined : (page.cursor ?? undefined);
    } while (cursor !== undefined);
    if (mismatched.length === 0 && deps.blobs !== undefined) {
      for (const blob of await (await deps.blobs(workspaceId)).listObjectBlobs()) {
        if (mismatched.length > 0) break;
        await check(storageObjectName(workspaceId, 'session-state', blob.objectId), blob);
      }
    }
    legacyRows += await countLegacy(deps, workspaceId);
    if (mismatched.length > 0) break;
  }
  return {
    rowsChecked,
    legacyRows,
    mismatches: mismatched.length,
    mismatched: mismatched.slice(0, SAMPLE_SIZE),
  };
}

const SKILL_MARKERS = [
  ['skill-meta/', 'meta'],
  ['skill-deletes/', 'deletes'],
  ['skill-builtin/', 'builtin'],
] as const;

function skillMarkerOf(key: string): { kind: 'meta' | 'deletes' | 'builtin'; name: string } | null {
  for (const [prefix, kind] of SKILL_MARKERS) {
    if (key.startsWith(prefix) && key.endsWith('.json')) {
      const name = key.slice(prefix.length, -'.json'.length);
      if (name !== '' && !name.includes('/')) return { kind, name };
    }
  }
  return null;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Does the catalog hold a revision row `.skills/<name>@<n>/...`? Rows list by path and nothing sorts
 * between `?` and `@`, so the first row after `.skills/<name>?` is a revision row or none is there.
 */
async function hasRevisionRows(catalog: FinalizeCatalog, name: string): Promise<boolean> {
  const page = await catalog.list(SKILL_ROWS_ROOT, {
    limit: 1,
    cursor: `${skillRowFolder(name)}?`,
  });
  return page.rows.some((row) => row.path.startsWith(`${skillRowFolder(name)}@`));
}

type OldStore = ReturnType<ObjectStoreProviderV2['forWorkspace']>;
type SkillMarker = NonNullable<ReturnType<typeof skillMarkerOf>>;

/**
 * Is the information of this skill marker already in its row's column (copied there now if it was
 * not), so the marker object may go? A marker of a skill with no row goes only when the skill is
 * really gone: its files or revisions may still be there, and the marker is then all that records it.
 */
async function markerIsRedundant(
  store: OldStore,
  catalog: FinalizeCatalog,
  skills: readonly CatalogSkill[],
  marker: SkillMarker,
  key: string,
): Promise<boolean> {
  const row = skills.find((skill) => skill.name === marker.name);
  if (row === undefined) {
    // The legacy files may be gone already (their twins are deleted once switched), so the
    // catalog's rows of the skill, current files and every revision, count as well.
    return (
      (await store.listPrefix(`skills/${marker.name}`)).length === 0 &&
      (await store.listPrefix(`skill-revisions/${marker.name}`)).length === 0 &&
      (await catalog.list(skillRowFolder(marker.name), { limit: 1 })).rows.length === 0 &&
      !(await hasRevisionRows(catalog, marker.name))
    );
  }
  if (marker.kind === 'meta') {
    if (row.meta !== null) return true;
    const body = await store.get(key);
    const record = body === null ? null : parseJson(body.body);
    return record !== null && (await catalog.setSkillMeta(marker.name, record, true));
  }
  if (marker.kind === 'builtin') {
    if (row.builtinDigest !== null) return true;
    const body = await store.get(key);
    const digest =
      body === null ? null : (parseJson(body.body) as { digest?: unknown } | null)?.digest;
    if (typeof digest !== 'string') return false;
    await catalog.setSkillBuiltinDigest(marker.name, digest);
    return true;
  }
  // The backfill follows the in-use rule: a skill an agent has assigned ignores its marker.
  if (row.pendingDelete === null) await pendingSkillDelete(store, catalog, marker.name);
  return true;
}

/**
 * Which keys of one listing page of an area's old store may be deleted. A key is deleted only when a
 * row proves it is not any row's current bytes, or, for a marker, when its information is in a column.
 */
async function deletableKeys(
  deps: FinalizeDependencies,
  workspaceId: string,
  area: StorageArea,
  keys: readonly string[],
): Promise<ReadonlySet<string>> {
  const store = deps.legacy[area]?.forWorkspace(workspaceId);
  if (store === undefined) return new Set();

  if (area === 'session-state') {
    // Deleted only when a moved row names it as its old twin and no row without an object id
    // still holds it as its bytes. A blob no row names is unaccounted and kept.
    if (deps.blobs === undefined) return new Set();
    const blobs = await deps.blobs(workspaceId);
    const held = new Set(await blobs.legacyBlobKeysHeld(keys));
    const moved = new Set((await blobs.listObjectBlobs()).map((blob) => blob.storageKey));
    return new Set(keys.filter((key) => moved.has(key) && !held.has(key)));
  }

  const catalog = await deps.catalog(workspaceId);
  const doomed = new Set<string>();
  const rowKeys: string[] = [];
  const skills = area === 'skills' ? await catalog.listSkills() : [];
  for (const key of keys) {
    const marker = area === 'skills' ? skillMarkerOf(key) : null;
    if (marker !== null) {
      if (await markerIsRedundant(store, catalog, skills, marker, key)) doomed.add(key);
    } else if (area === 'files' && key.split('/').at(-1) === EMPTY_FOLDER_MARKER) {
      const folder = key.slice(0, Math.max(key.length - EMPTY_FOLDER_MARKER.length - 1, 0));
      if (folder === '' || (await catalog.get(folder))?.kind === 'folder') doomed.add(key);
    } else rowKeys.push(key);
  }

  const holders = await catalog.holdersOfKeys(area, rowKeys);
  for (const key of rowKeys) {
    const current = holders.some(
      (row) => (row.objectId ?? null) === null && row.storageKey === key,
    );
    const moved = holders.some(
      (row) =>
        (row.objectId ?? null) !== null &&
        (row.storageKey === key || (area === 'files' && row.path === key)),
    );
    if (moved && !current) doomed.add(key);
  }
  return doomed;
}

interface Tally {
  deleted: number;
  unaccounted: number;
  readonly sample: string[];
}

/** Delete what is accounted for in one area's old store of one workspace, page by page. */
async function sweepArea(
  deps: FinalizeDependencies,
  workspaceId: string,
  area: StorageArea,
  tally: Tally,
): Promise<void> {
  const store = deps.legacy[area]?.forWorkspace(workspaceId);
  if (store === undefined) return;
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await store.listPage('', {
      recursive: true,
      limit: deps.pageSize ?? LIST_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const keys = page.entries.flatMap((entry) => (entry.kind === 'file' ? [entry.key] : []));
    const doomed = await deletableKeys(deps, workspaceId, area, keys);
    for (const key of keys) {
      if (doomed.has(key)) {
        await store.delete(key);
        tally.deleted += 1;
      } else {
        tally.unaccounted += 1;
        if (tally.sample.length < SAMPLE_SIZE) tally.sample.push(`${area}:${workspaceId}:${key}`);
      }
    }
    pages += 1;
    deps.log.info(
      JSON.stringify({
        event: 'storage-migrate',
        mode: 'finalize',
        area,
        pages,
        deleted: tally.deleted,
      }),
    );
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
}

/**
 * Delete the old copies that are accounted for, page by page, when the latest recorded pass was
 * clean and no row has gone back to the old naming since. Anything else is kept and reported.
 */
// @story US-STO-13
// storage-bridge(#1699): old object naming
export async function deleteLegacy(deps: FinalizeDependencies): Promise<DeleteResult> {
  const { log } = deps;
  const refuse = (refused: NonNullable<DeleteResult['refused']>, deleted = 0): DeleteResult => ({
    refused,
    deleted,
    unaccounted: 0,
    unaccountedSample: [],
  });
  const latest = await deps.runs.latest();
  if (latest === null) return refuse('no-pass');
  if (latest.legacyRows !== 0 || latest.mismatches !== 0) return refuse('unclean-pass');

  // A pass can be stale: rows may have come back since (an adopt, a server on the old naming).
  const workspaceIds = await deps.workspaceIds();
  for (const workspaceId of workspaceIds) {
    if ((await countLegacy(deps, workspaceId)) > 0) return refuse('legacy-rows');
  }

  const tally: Tally = { deleted: 0, unaccounted: 0, sample: [] };
  for (const workspaceId of workspaceIds) {
    // Checked again right before this workspace's objects go.
    if ((await countLegacy(deps, workspaceId)) > 0) return refuse('legacy-rows', tally.deleted);
    for (const area of LEGACY_AREAS) await sweepArea(deps, workspaceId, area, tally);
  }
  const { deleted, unaccounted, sample } = tally;
  if (unaccounted > 0) {
    // No row accounts for these. The adopt stage gives a file one; run it, then copy, then finalize.
    log.warn(
      JSON.stringify({
        event: 'storage-migrate',
        mode: 'finalize',
        unaccounted,
        sample,
        note: 'kept: no catalog row accounts for these old objects',
      }),
    );
  }
  return { refused: null, deleted, unaccounted, unaccountedSample: sample };
}

/**
 * `AW_STORAGE_MIGRATE=finalize`: verify every object, record the pass, then delete the old copies if
 * the pass was clean. Stopped at any point, the next run starts from the check again.
 */
// @story US-STO-13
// storage-bridge(#1699): old object naming
export async function runFinalizeStage(deps: FinalizeDependencies): Promise<FinalizeReport> {
  const verify = await verifyAll(deps);
  await deps.runs.record({
    rowsChecked: verify.rowsChecked,
    legacyRows: verify.legacyRows,
    mismatches: verify.mismatches,
  });
  deps.log.info(JSON.stringify({ event: 'storage-migrate', mode: 'finalize', verify }));
  if (verify.mismatches > 0 || verify.legacyRows > 0) {
    deps.log.warn(
      JSON.stringify({
        event: 'storage-migrate',
        mode: 'finalize',
        blocked: verify.mismatches > 0 ? 'mismatch' : 'legacy-rows',
      }),
    );
    return { verify, outcome: 'blocked', delete: null };
  }
  const result = await deleteLegacy(deps);
  return { verify, outcome: result.refused === null ? 'deleted' : 'blocked', delete: result };
}
