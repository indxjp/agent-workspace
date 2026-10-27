/**
 * The adopt stage of the move off the old object naming (the storage design, §04): every object the
 * old layout left without a catalog row gets a `ready` legacy row at its own path, so the catalog
 * lists it. Nothing is written to the object store, and a path that has a row in any status is left
 * alone, so a removed file never comes back. Safe to repeat and to run on two instances at once.
 * Each pass is recorded as an `adopt` run with what it skipped, by reason.
 */
import {
  newObjectId,
  ObjectConflictError,
  storageObjectName,
  type ObjectStoreProviderV2,
  type ObjectStoreV2,
  type StorageArea,
} from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';

import { parseLegacyKey } from './legacy-naming';
import { measure } from './measure';
import type { LegacyAdopter, LegacyBlobCopier, LegacyCopier, MigrationRuns } from './store';

const PAGE_SIZE = 1000;
const BATCH_SIZE = 50;

export interface AdoptDependencies {
  readonly objects: ObjectStoreV2;
  /** The legacy area prefix to list, with no trailing slash (`legacyAreaPrefixes`). */
  readonly prefix: string;
  /** Rejects for a workspace that no longer exists. */
  readonly catalog: (workspaceId: string) => Promise<LegacyAdopter>;
  /** The workspace owner's principal, or `null` when it has none. */
  readonly ownerPrincipalId: (workspaceId: string) => Promise<string | null>;
  readonly runs: MigrationRuns;
  readonly log: Logger;
  /** Objects per listing page. Defaults to the store's maximum. */
  readonly pageSize?: number;
}

export interface AdoptReport {
  readonly adopted: number;
  /** Objects whose path already had a row, in any status. */
  readonly hadRow: number;
  /** Objects left alone: another row holds the path, or the workspace is gone or has no owner. */
  readonly skipped: number;
  /** {@link skipped} by reason: the workspace has no owner, another row holds the path, it failed. */
  readonly ownerless: number;
  readonly pathTaken: number;
  readonly failed: number;
  /** Workspaces that failed; the pass is clean only when there are none. */
  readonly failedWorkspaces: number;
}

type LegacyFile = Parameters<LegacyAdopter['adoptLegacyFiles']>[0][number];

// @story US-STO-13
// storage-bridge(#1699): old object naming
export async function runAdoptStage(deps: AdoptDependencies): Promise<AdoptReport> {
  const { objects, prefix, log } = deps;
  const report = {
    adopted: 0,
    hadRow: 0,
    skipped: 0,
    ownerless: 0,
    pathTaken: 0,
    failed: 0,
    failedWorkspaces: 0,
  };
  const owners = new Map<string, string | null>();
  const adopt = async (workspaceId: string, found: readonly LegacyFile[]): Promise<void> => {
    let done = 0;
    try {
      let owner = owners.get(workspaceId);
      if (owner === undefined) owner = await deps.ownerPrincipalId(workspaceId);
      owners.set(workspaceId, owner);
      if (owner === null) {
        report.skipped += found.length;
        report.ownerless += found.length;
        return;
      }
      const catalog = await deps.catalog(workspaceId);
      for (let start = 0; start < found.length; start += BATCH_SIZE) {
        const batch = found.slice(start, start + BATCH_SIZE);
        const outcome = await catalog.adoptLegacyFiles(batch, owner);
        report.adopted += outcome.adopted;
        report.hadRow += outcome.hadRow;
        report.skipped += outcome.pathTaken;
        report.pathTaken += outcome.pathTaken;
        done += batch.length;
      }
    } catch (error) {
      // A workspace that is gone, or a store that fails, must not stop the others; the next start
      // finds what is left. Only the error name is logged: the message can carry connection text.
      log.warn('[storage] adopting legacy files failed for a workspace', {
        stage: 'adopt',
        name: error instanceof Error ? error.name : 'unknown',
      });
      report.skipped += found.length - done;
      report.failed += found.length - done;
      report.failedWorkspaces += 1;
    }
  };

  let cursor: string | undefined;
  let pages = 0;
  do {
    const before = { ...report };
    const page = await objects.listPage(prefix, {
      recursive: true,
      limit: deps.pageSize ?? PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const byWorkspace = new Map<string, LegacyFile[]>();
    for (const entry of page.entries) {
      if (entry.kind !== 'file') continue;
      const parsed = parseLegacyKey(prefix, entry.key);
      if (parsed === null) continue;
      const found = byWorkspace.get(parsed.workspaceId) ?? [];
      found.push({
        storageKey: parsed.path,
        sizeBytes: entry.sizeBytes,
        contentType: entry.contentType,
      });
      byWorkspace.set(parsed.workspaceId, found);
    }
    for (const [workspaceId, found] of byWorkspace) await adopt(workspaceId, found);
    pages += 1;
    log.info('[storage] adopting legacy files', {
      stage: 'adopt',
      page: pages,
      adopted: report.adopted - before.adopted,
      hadRow: report.hadRow - before.hadRow,
      skipped: report.skipped - before.skipped,
    });
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
  await recordAdoptRun(deps.runs, report);
  log.info('[storage] adopted legacy files', { stage: 'adopt', pages, ...report });
  return report;
}

/**
 * Record the pass as an `adopt` run: `rowsChecked` = objects adopted, `legacyRows` = objects
 * skipped, `mismatches` = failed workspaces. A pass that adopted nothing and found what the last
 * one found is not recorded again, so a start-up with nothing to do writes nothing.
 */
async function recordAdoptRun(runs: MigrationRuns, report: AdoptReport): Promise<void> {
  const run = {
    rowsChecked: report.adopted,
    legacyRows: report.skipped,
    mismatches: report.failedWorkspaces,
    skippedOwnerless: report.ownerless,
    skippedPathTaken: report.pathTaken,
    skippedFailed: report.failed,
    clean: report.failedWorkspaces === 0,
  };
  const last = await runs.latest('adopt');
  const unchanged =
    last !== null &&
    (Object.keys(run) as (keyof typeof run)[]).every((field) => last[field] === run[field]);
  if (report.adopted > 0 || !unchanged) await runs.record({ stage: 'adopt', ...run });
}

const PROGRESS_EVERY = 100;
const LIST_LIMIT = 1000;

/** The counts of one area; `found` is every row the work list held, the rest say what became of it. */
interface AreaCounts {
  found: number;
  switched: number;
  /** Renamed, replaced, removed or switched by someone else while the copy ran; the copy was deleted. */
  raced: number;
  /** The old object is not there; the row is left as it is. */
  missing: number;
  /** The copy's size or checksum differs from the old object's or the row's; the copy was deleted. */
  mismatched: number;
  /** A store or catalog call failed; the row is left for the next run. */
  failed: number;
  /** No old store is configured for the area, so its rows cannot be copied. */
  noStore: number;
}

export interface CopyReport {
  readonly mode: 'copy' | 'copy-dry-run';
  readonly areas: Readonly<Record<string, AreaCounts>>;
}

export interface CopyDependencies {
  /** The shared root, new naming. */
  readonly objects: ObjectStoreV2;
  /** The old store of each area; an area without one cannot be copied. */
  readonly legacy: Partial<Readonly<Record<StorageArea, ObjectStoreProviderV2>>>;
  /** Rejects for a workspace that no longer exists. */
  readonly catalog: (workspaceId: string) => Promise<LegacyCopier>;
  /** The session-state blob rows of a workspace; absent when this deployment has none. */
  readonly blobs?: (workspaceId: string) => Promise<LegacyBlobCopier>;
  readonly workspaceIds: () => Promise<readonly string[]>;
  readonly mode: 'copy' | 'copy-dry-run';
  readonly log: Logger;
}

type Outcome = 'switched' | 'raced' | 'missing' | 'mismatched';

interface Source {
  readonly store: ObjectStoreV2;
  readonly key: string;
  readonly contentType: string | null;
  /** The checksum the row already holds, or `null` when it has none. */
  readonly sha256: string | null;
}

/**
 * Copy one old object to a new name, check the copy, then switch the row. If the process dies:
 * before the write finishes, the store holds nothing or a partial object no row names; after the
 * write and before the switch, one object under the new naming that no row names, which the cleanup
 * job reports and, in `delete` mode, removes once it is old enough; after the switch, nothing is
 * lost, because the old object is still there. A `switch` that throws may have committed with its
 * reply lost, so the copy is then kept, never deleted. No object store call runs inside a database
 * transaction: the switch is one conditional `UPDATE`.
 */
async function copyOne(
  deps: CopyDependencies,
  workspaceId: string,
  area: StorageArea,
  source: Source,
  switchRow: (objectId: string, sha256: string) => Promise<boolean>,
): Promise<Outcome> {
  const head = await source.store.head(source.key);
  if (head === null) return 'missing';
  const stream = await source.store.read(source.key);
  if (stream === null) return 'missing';
  const objectId = newObjectId();
  const name = storageObjectName(workspaceId, area, objectId);
  // A copy that cannot be deleted is an orphan the cleanup job reports; it must not hide the outcome.
  const discard = () =>
    deps.objects.delete(name).catch((error: unknown) => {
      deps.log.warn('[storage] could not delete a copy; the cleanup job will', {
        name: error instanceof Error ? error.name : 'unknown',
      });
    });
  // The old object is already stored, so no size limit applies; the stream is never buffered whole.
  const measured = measure(Number.MAX_SAFE_INTEGER);
  try {
    await deps.objects.write(name, stream.body.pipeThrough(measured.stream), {
      ifNoneMatch: '*',
      contentType: head.contentType ?? source.contentType ?? 'application/octet-stream',
    });
  } catch (error) {
    // An object that was already there is not ours to delete.
    if (!(error instanceof ObjectConflictError)) await discard();
    throw error;
  }
  const { sizeBytes, sha256 } = measured.result();
  if (sizeBytes !== head.sizeBytes || (source.sha256 !== null && source.sha256 !== sha256)) {
    await discard();
    return 'mismatched';
  }
  if (!(await switchRow(objectId, sha256))) {
    await discard();
    return 'raced';
  }
  return 'switched';
}

/**
 * The copy stage of the move off the old object naming (the storage design, §06): for every row
 * still without an object id, copy its object to a new name, check the copy, and switch the row.
 * The work list is the rows themselves, so a stopped run resumes where it left off; one row at a
 * time. Old objects are not deleted here. `copy-dry-run` only counts.
 */
// @story US-STO-13
// storage-bridge(#1699): old object naming
export async function runCopyStage(deps: CopyDependencies): Promise<CopyReport> {
  const { log } = deps;
  const areas: Record<string, AreaCounts> = {};
  const countsOf = (area: string): AreaCounts =>
    (areas[area] ??= {
      found: 0,
      switched: 0,
      raced: 0,
      missing: 0,
      mismatched: 0,
      failed: 0,
      noStore: 0,
    });
  let seen = 0;
  const progress = (done: boolean) =>
    log.info(JSON.stringify({ event: 'storage-migrate', mode: deps.mode, done, areas }));

  /** Count one work-list row and, when copying, move it. A failure of one row never stops the run. */
  const visit = async (
    area: StorageArea,
    workspaceId: string,
    source: Source | null,
    switchRow: (objectId: string, sha256: string) => Promise<boolean>,
  ): Promise<void> => {
    const counts = countsOf(area);
    counts.found += 1;
    seen += 1;
    try {
      if (source === null) counts.noStore += 1;
      else if (deps.mode === 'copy') {
        counts[await copyOne(deps, workspaceId, area, source, switchRow)] += 1;
      }
    } catch (error) {
      // Only the error name is logged: a message can carry connection text or a signed URL.
      log.warn('[storage] copying a legacy object failed', {
        area,
        name: error instanceof Error ? error.name : 'unknown',
      });
      counts.failed += 1;
    }
    if (seen % PROGRESS_EVERY === 0) progress(false);
  };

  for (const workspaceId of await deps.workspaceIds()) {
    try {
      const catalog = await deps.catalog(workspaceId);
      let cursor: string | undefined;
      do {
        const page = await catalog.list('', {
          limit: LIST_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const row of page.rows) {
          const storageKey = row.storageKey;
          if (row.kind !== 'file' || (row.objectId ?? null) !== null || storageKey === null) {
            continue;
          }
          const area = row.area ?? 'files';
          const legacy = deps.legacy[area];
          await visit(
            area,
            workspaceId,
            legacy === undefined
              ? null
              : {
                  store: legacy.forWorkspace(workspaceId),
                  key: storageKey,
                  contentType: row.contentType,
                  sha256: row.sha256 ?? null,
                },
            (objectId, sha256) => catalog.switchObject(row.id, storageKey, objectId, sha256),
          );
        }
        cursor = page.cursor ?? undefined;
      } while (cursor !== undefined);

      if (deps.blobs !== undefined) {
        const blobs = await deps.blobs(workspaceId);
        const legacy = deps.legacy['session-state'];
        for (const blob of await blobs.listLegacyBlobs()) {
          await visit(
            'session-state',
            workspaceId,
            legacy === undefined
              ? null
              : {
                  store: legacy.forWorkspace(workspaceId),
                  key: blob.storageKey,
                  contentType: 'application/octet-stream',
                  sha256: blob.sha256,
                },
            (objectId) => blobs.switchBlobObject(blob, blob.storageKey, objectId),
          );
        }
      }
    } catch (error) {
      // A workspace that is gone must not stop the others; the next run finds what is left.
      log.warn('[storage] copying legacy objects failed for a workspace', {
        name: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  progress(true);
  return { mode: deps.mode, areas };
}
