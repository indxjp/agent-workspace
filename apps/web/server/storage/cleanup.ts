/**
 * The storage cleanup pass (the storage design, §04 "The cleanup job"): finish deletes that were
 * interrupted, settle uploads that never completed, and find objects no catalog row points at. An
 * object is removed only when no row in any status references it (a `session-state` object: no
 * session-state blob row in any status), and never when it is younger than the longest signed link
 * plus an hour. In `report` mode the pass reads and counts and writes nothing. One copy at a time is
 * the caller's job (`cleanup-cron.ts` holds the database lock).
 */
import { PRESIGNED_URL_MAX_TTL_SECONDS } from '@indx-workspace/contracts/files';
import {
  parseStorageObjectName,
  storageObjectName,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';

import { promoteUpload } from './promote-upload';
import type { CatalogFile, CatalogPort, SessionStateBlobSettler } from './store';

/** The longest a signed link lives, plus an hour: nothing younger is touched. */
export const CLEANUP_MIN_AGE_MS = (PRESIGNED_URL_MAX_TTL_SECONDS + 3600) * 1000;

const PAGE_SIZE = 1000;

export interface CleanupReport {
  readonly mode: 'report' | 'delete';
  /** Objects listed under the workspaces prefix. */
  readonly scanned: number;
  /** Objects no row references and that are old enough to remove. */
  readonly orphans: number;
  readonly stalePendingReady: number;
  readonly stalePendingDeleted: number;
  /** Rows marked `deleting` whose object is gone and whose row is dropped. */
  readonly deletingFinished: number;
  readonly skippedYoung: number;
  /** Orphans actually removed; always 0 in `report` mode. */
  readonly deleted: number;
}

export interface CleanupDependencies {
  /** The shared root. */
  readonly objects: ObjectStore;
  /** Rejects for a workspace that no longer exists. */
  readonly catalogs: (workspaceId: string) => Promise<CatalogPort>;
  /** The session-state blob rows of a workspace, which the `session-state` objects belong to. */
  readonly sessionState: (workspaceId: string) => Promise<SessionStateBlobSettler>;
  readonly workspaceIds: () => Promise<readonly string[]>;
  readonly now: () => Date;
  readonly mode: 'report' | 'delete';
  readonly log: Logger;
  /** Objects per listing page. Defaults to the store's maximum. */
  readonly pageSize?: number;
}

type Counts = { -readonly [Key in keyof CleanupReport]: CleanupReport[Key] };

interface Pass {
  readonly deps: CleanupDependencies;
  readonly counts: Counts;
  /** Rows reserved, and objects modified, after this instant are too young to touch. */
  readonly cutoff: Date;
}

/** One listed object, named by the object id a row would hold for it. */
interface Candidate {
  readonly area: string;
  readonly key: string;
  readonly objectId: string;
}

/** A failure of one step must not stop the others; only the error name is logged. */
async function attempt(pass: Pass, stage: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    pass.deps.log.warn('[storage] a cleanup step failed', {
      stage,
      name: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/** Where a row's bytes are, as `service.ts` finds them; `null` for a row with no object id. */
function locate(workspaceId: string, row: CatalogFile) {
  const objectId = row.objectId ?? null;
  if (objectId === null) return null;
  return {
    objectId,
    name: storageObjectName(workspaceId, row.area ?? 'files', objectId),
  };
}

async function finishDeletes(pass: Pass, workspaceId: string, catalog: CatalogPort) {
  for (const row of await catalog.deleting()) {
    await attempt(pass, 'deleting', async () => {
      const object = locate(workspaceId, row);
      if (object === null) return;
      if (pass.deps.mode === 'delete') {
        // Another live row naming the same object owns it now.
        const holders = await catalog.referencing({ objectIds: [object.objectId] });
        const shared = holders.some((other) => other.id !== row.id && other.status !== 'deleting');
        if (!shared) await pass.deps.objects.delete(object.name);
        await catalog.forget(row);
      }
      pass.counts.deletingFinished += 1;
    });
  }
}

async function settleStalePending(pass: Pass, workspaceId: string, catalog: CatalogPort) {
  for (const row of await catalog.stalePending(pass.cutoff)) {
    await attempt(pass, 'stale-pending', async () => {
      const object = locate(workspaceId, row);
      if (object === null) return;
      const meta = await pass.deps.objects.head(object.name);
      // A pending row declares its size when reserved, so an object of that size is what was
      // uploaded, whether it is a signed-link upload or a save that wrote its bytes but not its confirm.
      const mutating = pass.deps.mode === 'delete';
      // A staging row is a temporary file that is never confirmed: an object of its size is
      // deleted like any other leftover (the storage design, §04 "Where files live").
      if (row.area !== 'staging' && meta !== null && meta.sizeBytes === row.sizeBytes) {
        if (!mutating) {
          pass.counts.stalePendingReady += 1;
          return;
        }
        // The checksum is of the bytes in the store; bytes that are not the declared ones fall
        // through to the delete below. The row is published on a copy, as `completeUpload` does
        // (`promote-upload.ts`).
        const promoted = await promoteUpload(
          { objects: pass.deps.objects, catalog, log: pass.deps.log },
          workspaceId,
          { ...row, objectId: object.objectId },
          row.sizeBytes,
        );
        if (promoted.kind === 'stale') return;
        if (promoted.kind === 'confirmed') {
          pass.counts.stalePendingReady += 1;
          return;
        }
      }
      if (mutating) {
        // Claimed before its bytes go: a row confirmed or reserved again since it was listed is
        // no longer the abandoned upload this pass looked at, and keeps its object.
        const [claimed] = await catalog.remove(row.targetPath ?? row.path, { pending: row });
        if (claimed === undefined) return;
        if (meta !== null) await pass.deps.objects.delete(object.name);
        await catalog.forget(claimed);
      }
      pass.counts.stalePendingDeleted += 1;
    });
  }
}

/**
 * Finish what a session-state save or purge left: a `deleting` row's object, then the row; and a
 * reservation older than the cutoff, claimed (`deleting`) before its object goes, so a save that
 * confirms meanwhile keeps its bytes.
 */
async function settleSessionState(pass: Pass, workspaceId: string) {
  const rows = await pass.deps.sessionState(workspaceId);
  for (const row of await rows.unsettledBlobs(pass.cutoff)) {
    await attempt(pass, 'session-state', async () => {
      if (pass.deps.mode === 'delete') {
        const doomed = row.status === 'pending' ? await rows.claimBlob(row) : row;
        if (doomed === null) return;
        await pass.deps.objects.delete(
          storageObjectName(workspaceId, 'session-state', row.objectId),
        );
        await rows.forgetBlob(doomed);
      }
      if (row.status === 'pending') pass.counts.stalePendingDeleted += 1;
      else pass.counts.deletingFinished += 1;
    });
  }
}

/** Which of `found` a row holds: a files-catalog row, or a session-state blob row in any status. */
async function referencedAmong(
  pass: Pass,
  catalog: CatalogPort,
  workspaceId: string,
  found: readonly Candidate[],
): Promise<(entry: Candidate) => boolean> {
  const rows = await catalog.referencing({ objectIds: found.map((entry) => entry.objectId) });
  const stateIds = found.flatMap((entry) =>
    entry.area === 'session-state' ? [entry.objectId] : [],
  );
  const held = new Set(
    stateIds.length === 0
      ? []
      : await (await pass.deps.sessionState(workspaceId)).referencedObjectIds(stateIds),
  );
  return (entry) => rows.some((row) => row.objectId === entry.objectId) || held.has(entry.objectId);
}

/** Count the orphans among one workspace's old-enough objects; in delete mode remove them. */
async function sweepWorkspace(pass: Pass, workspaceId: string, found: readonly Candidate[]) {
  await attempt(pass, 'orphans', async () => {
    // A workspace that is gone rejects here: its objects are not ours to call orphans.
    const catalog = await pass.deps.catalogs(workspaceId);
    const isReferenced = await referencedAmong(pass, catalog, workspaceId, found);
    for (const entry of found) {
      if (isReferenced(entry)) continue;
      pass.counts.orphans += 1;
      if (pass.deps.mode !== 'delete') continue;
      await attempt(pass, 'delete-orphan', async () => {
        // A row may have been written since the page was read: look again at this one object.
        if ((await referencedAmong(pass, catalog, workspaceId, [entry]))(entry)) return;
        await pass.deps.objects.delete(entry.key);
        pass.counts.deleted += 1;
      });
    }
  });
}

/** List the workspaces prefix page by page; a key that is no object name is not ours. */
async function sweepListing(pass: Pass) {
  let cursor: string | undefined;
  do {
    const page = await pass.deps.objects.listPage('workspaces', {
      recursive: true,
      limit: pass.deps.pageSize ?? PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const byWorkspace = new Map<string, Candidate[]>();
    for (const entry of page.entries) {
      if (entry.kind !== 'file') continue;
      const parsed = parseStorageObjectName(entry.key);
      if (parsed === null) continue;
      pass.counts.scanned += 1;
      if (entry.lastModified.getTime() > pass.cutoff.getTime()) {
        pass.counts.skippedYoung += 1;
        continue;
      }
      const found = byWorkspace.get(parsed.workspaceId) ?? [];
      found.push({ area: parsed.area, key: entry.key, objectId: parsed.objectId });
      byWorkspace.set(parsed.workspaceId, found);
    }
    for (const [workspaceId, found] of byWorkspace) {
      await sweepWorkspace(pass, workspaceId, found);
    }
    cursor = page.cursor ?? undefined;
  } while (cursor !== undefined);
}

// @story US-STO-02
// @story US-STO-04
// @story US-STO-14
export async function runCleanupPass(deps: CleanupDependencies): Promise<CleanupReport> {
  const counts: Counts = {
    mode: deps.mode,
    scanned: 0,
    orphans: 0,
    stalePendingReady: 0,
    stalePendingDeleted: 0,
    deletingFinished: 0,
    skippedYoung: 0,
    deleted: 0,
  };
  const pass: Pass = {
    deps,
    counts,
    cutoff: new Date(deps.now().getTime() - CLEANUP_MIN_AGE_MS),
  };
  for (const workspaceId of await deps.workspaceIds()) {
    await attempt(pass, 'workspace', async () => {
      const catalog = await deps.catalogs(workspaceId);
      await finishDeletes(pass, workspaceId, catalog);
      await settleStalePending(pass, workspaceId, catalog);
      await settleSessionState(pass, workspaceId);
    });
  }
  await sweepListing(pass);
  deps.log.info('storage cleanup', { ...counts });
  return counts;
}
