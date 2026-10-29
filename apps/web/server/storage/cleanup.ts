/**
 * The storage cleanup pass (the storage design, §04 "The cleanup job"): finish deletes that were
 * interrupted, settle uploads that never completed, and find objects no catalog row points at, in
 * the new naming and the old one. An object is removed only when no row in any status references
 * it (a `session-state` object: no session-state blob row in any status), and never when it is
 * younger than the longest signed link plus an hour. In `report` mode the
 * pass reads and counts and writes nothing. An object in the old naming is counted and reported
 * in either mode and never deleted: a row-less old object may be a file adopt has not reached.
 * One copy at a time is the caller's job (`cleanup-cron.ts` holds the database lock).
 */
import { PRESIGNED_URL_MAX_TTL_SECONDS } from '@indx-workspace/contracts/files';
import {
  parseStorageObjectName,
  storageObjectName,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';

import { parseLegacyKey } from './legacy-naming';
import { BodyTooLargeError, measure } from './measure';
import { promoteUpload } from './promote-upload';
import type { CatalogFile, CatalogPort } from './store';

/** The longest a signed link lives, plus an hour: nothing younger is touched. */
export const CLEANUP_MIN_AGE_MS = (PRESIGNED_URL_MAX_TTL_SECONDS + 3600) * 1000;

const PAGE_SIZE = 1000;

export interface CleanupReport {
  readonly mode: 'report' | 'delete';
  /** Objects listed in a naming this job owns. */
  readonly scanned: number;
  /** Objects no row references and that are old enough to remove. */
  readonly orphans: number;
  /** The orphans in the old naming: counted in both modes, never deleted. */
  readonly legacyOrphans: number;
  readonly stalePendingReady: number;
  readonly stalePendingDeleted: number;
  /** Rows marked `deleting` whose object is gone and whose row is dropped. */
  readonly deletingFinished: number;
  readonly skippedYoung: number;
  /** Orphans actually removed; always 0 in `report` mode. */
  readonly deleted: number;
}

export interface CleanupDependencies {
  /** The shared root, new naming. */
  readonly objects: ObjectStore;
  /** The old files layout (`legacyAreaPrefixes`); `null` when the deployment has none. */
  readonly legacy: { readonly objects: ObjectStore; readonly prefix: string } | null;
  /** Rejects for a workspace that no longer exists. */
  readonly catalogs: (workspaceId: string) => Promise<CatalogPort>;
  /** The session-state blob rows of a workspace, which the `session-state` objects belong to. */
  readonly sessionState: (workspaceId: string) => Promise<{
    referencedObjectIds(objectIds: readonly string[]): Promise<readonly string[]>;
  }>;
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

/** One listed object, named by the id or the storage key a row would hold for it. */
interface Candidate {
  readonly area: string;
  readonly key: string;
  readonly objectId: string | null;
  readonly storageKey: string | null;
}

/** What a listed key names: the workspace, and the object id (new naming) or catalog path (old). */
interface Parsed {
  readonly area: string;
  readonly workspaceId: string;
  readonly objectId: string | null;
  readonly path: string | null;
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

/** Where a row's bytes are, as `service.ts` finds them; `null` when no store holds that naming. */
function locate(deps: CleanupDependencies, workspaceId: string, row: CatalogFile) {
  const area = row.area ?? 'files';
  const objectId = row.objectId ?? null;
  if (objectId !== null) {
    return { store: deps.objects, name: storageObjectName(workspaceId, area, objectId) };
  }
  // storage-bridge(#1699): rows still in the old naming keep their bytes at the old key
  if (deps.legacy === null || area !== 'files' || row.storageKey === null) return null;
  return {
    store: deps.legacy.objects,
    name: `${deps.legacy.prefix}/${workspaceId}/${row.storageKey}`,
  };
}

const lookupOf = (found: readonly Candidate[]) => ({
  objectIds: found.flatMap((entry) => (entry.objectId === null ? [] : [entry.objectId])),
  storageKeys: found.flatMap((entry) => (entry.storageKey === null ? [] : [entry.storageKey])),
});

async function finishDeletes(pass: Pass, workspaceId: string, catalog: CatalogPort) {
  for (const row of await catalog.deleting()) {
    await attempt(pass, 'deleting', async () => {
      const object = locate(pass.deps, workspaceId, row);
      if (object === null) return;
      if (pass.deps.mode === 'delete') {
        // Another live row on the same key (a path re-uploaded at once) owns the object now.
        const objectId = row.objectId ?? null;
        const holders = await catalog.referencing(
          lookupOf([
            {
              area: row.area ?? 'files',
              key: object.name,
              objectId,
              storageKey: objectId === null ? row.storageKey : null,
            },
          ]),
        );
        const shared = holders.some((other) => other.id !== row.id && other.status !== 'deleting');
        if (!shared) await object.store.delete(object.name);
        // storage-bridge(#1699): the old object of a row the copy stage switched goes with it, or
        // the adopt stage would give a removed file a row again.
        const { legacy } = pass.deps;
        if (
          !shared &&
          legacy !== null &&
          objectId !== null &&
          (row.area ?? 'files') === 'files' &&
          row.storageKey !== null &&
          row.storageKey !== `files/${objectId}`
        ) {
          await legacy.objects.delete(`${legacy.prefix}/${workspaceId}/${row.storageKey}`);
        }
        await catalog.forget(row);
      }
      pass.counts.deletingFinished += 1;
    });
  }
}

async function settleStalePending(pass: Pass, workspaceId: string, catalog: CatalogPort) {
  for (const row of await catalog.stalePending(pass.cutoff)) {
    await attempt(pass, 'stale-pending', async () => {
      const object = locate(pass.deps, workspaceId, row);
      if (object === null) return;
      const meta = await object.store.head(object.name);
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
        // through to the delete below. A row in the new naming is published on a copy, as
        // `completeUpload` does (`promote-upload.ts`).
        const objectId = row.objectId ?? null;
        if (objectId !== null) {
          const promoted = await promoteUpload(
            { objects: pass.deps.objects, catalog, log: pass.deps.log },
            workspaceId,
            { ...row, objectId },
            row.sizeBytes,
          );
          if (promoted.kind === 'stale') return;
          if (promoted.kind === 'confirmed') {
            pass.counts.stalePendingReady += 1;
            return;
          }
        } else {
          // A pending row in the old naming (`locate` above) is confirmed on its own object.
          const sum = await checksum(object, row.sizeBytes);
          if (sum !== null) {
            const done = await catalog.confirm(row, {
              sizeBytes: sum.sizeBytes,
              sha256: sum.sha256,
              contentType: row.contentType,
            });
            if (done === null) return;
            pass.counts.stalePendingReady += 1;
            return;
          }
        }
      }
      if (mutating) {
        // Claimed before its bytes go: a row confirmed or reserved again since it was listed is
        // no longer the abandoned upload this pass looked at, and keeps its object.
        const [claimed] = await catalog.remove(row.targetPath ?? row.path, { pending: row });
        if (claimed === undefined) return;
        if (meta !== null) await object.store.delete(object.name);
        await catalog.forget(claimed);
      }
      pass.counts.stalePendingDeleted += 1;
    });
  }
}

/** Stream the object through {@link measure}, as `completeUpload` does; `null` if it is not `sizeBytes` long. */
async function checksum(
  object: NonNullable<ReturnType<typeof locate>>,
  sizeBytes: number,
): Promise<{ readonly sizeBytes: number; readonly sha256: string } | null> {
  const stream = await object.store.read(object.name);
  if (stream === null) return null;
  const measured = measure(sizeBytes);
  try {
    await stream.body.pipeThrough(measured.stream).pipeTo(new WritableStream());
  } catch (error) {
    if (error instanceof BodyTooLargeError) return null;
    throw error;
  }
  const result = measured.result();
  return result.sizeBytes === sizeBytes ? result : null;
}

/** Which of `found` a row holds: a files-catalog row, or a session-state blob row in any status. */
async function referencedAmong(
  pass: Pass,
  catalog: CatalogPort,
  workspaceId: string,
  found: readonly Candidate[],
): Promise<(entry: Candidate) => boolean> {
  const rows = await catalog.referencing(lookupOf(found));
  const stateIds = found.flatMap((entry) =>
    entry.area === 'session-state' && entry.objectId !== null ? [entry.objectId] : [],
  );
  const held = new Set(
    stateIds.length === 0
      ? []
      : await (await pass.deps.sessionState(workspaceId)).referencedObjectIds(stateIds),
  );
  return (entry) =>
    rows.some((row) =>
      entry.objectId === null
        ? (row.objectId ?? null) === null && row.storageKey === entry.storageKey
        : row.objectId === entry.objectId,
    ) ||
    (entry.objectId !== null && held.has(entry.objectId));
}

/** Count the orphans among one workspace's old-enough objects; in delete mode remove them if `deletable`. */
async function sweepWorkspace(
  pass: Pass,
  store: ObjectStore,
  workspaceId: string,
  found: readonly Candidate[],
  deletable: boolean,
) {
  await attempt(pass, 'orphans', async () => {
    // A workspace that is gone rejects here: its objects are not ours to call orphans.
    const catalog = await pass.deps.catalogs(workspaceId);
    const isReferenced = await referencedAmong(pass, catalog, workspaceId, found);
    for (const entry of found) {
      if (isReferenced(entry)) continue;
      pass.counts.orphans += 1;
      if (!deletable) pass.counts.legacyOrphans += 1;
      if (!deletable || pass.deps.mode !== 'delete') continue;
      await attempt(pass, 'delete-orphan', async () => {
        // A row may have been written since the page was read: look again at this one object.
        if ((await referencedAmong(pass, catalog, workspaceId, [entry]))(entry)) return;
        await store.delete(entry.key);
        pass.counts.deleted += 1;
      });
    }
  });
}

/** List `prefix` page by page; `parse` names an object by workspace and id or storage key. */
async function sweepListing(
  pass: Pass,
  store: ObjectStore,
  prefix: string,
  parse: (key: string) => Parsed | null,
  deletable: boolean,
) {
  let cursor: string | undefined;
  do {
    const page = await store.listPage(prefix, {
      recursive: true,
      limit: pass.deps.pageSize ?? PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const byWorkspace = new Map<string, Candidate[]>();
    for (const entry of page.entries) {
      if (entry.kind !== 'file') continue;
      const parsed = parse(entry.key);
      if (parsed === null) continue;
      pass.counts.scanned += 1;
      if (entry.lastModified.getTime() > pass.cutoff.getTime()) {
        pass.counts.skippedYoung += 1;
        continue;
      }
      const found = byWorkspace.get(parsed.workspaceId) ?? [];
      found.push({
        area: parsed.area,
        key: entry.key,
        objectId: parsed.objectId,
        storageKey: parsed.path,
      });
      byWorkspace.set(parsed.workspaceId, found);
    }
    for (const [workspaceId, found] of byWorkspace) {
      await sweepWorkspace(pass, store, workspaceId, found, deletable);
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
    legacyOrphans: 0,
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
    });
  }
  await sweepListing(
    pass,
    deps.objects,
    'workspaces',
    (key) => {
      const parsed = parseStorageObjectName(key);
      return parsed === null
        ? null
        : {
            area: parsed.area,
            workspaceId: parsed.workspaceId,
            objectId: parsed.objectId,
            path: null,
          };
    },
    true,
  );
  if (deps.legacy !== null) {
    const { objects, prefix } = deps.legacy;
    // storage-bridge(#1699): objects still in the old naming are reported, never deleted
    await sweepListing(
      pass,
      objects,
      prefix,
      (key) => {
        const parsed = parseLegacyKey(prefix, key);
        return parsed === null
          ? null
          : { area: 'files', workspaceId: parsed.workspaceId, objectId: null, path: parsed.path };
      },
      false,
    );
  }
  deps.log.info('storage cleanup', { ...counts });
  return counts;
}
