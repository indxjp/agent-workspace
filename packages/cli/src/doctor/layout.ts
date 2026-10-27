/**
 * The "storage layout" check of `agent-workspace doctor`: how many objects each area still holds
 * in the old per-area naming (the storage design, §06 "Moving existing files safely").
 *
 * The prefixes come from `legacyAreaPrefixes` in contracts, the list the server's adopt stage
 * lists too. Read-only, and bounded: an area is counted up to {@link LEGACY_COUNT_CAP}, so a huge
 * bucket is never paged to the end. A message carries an area name and a number, never a key, a
 * path or the text of a provider error.
 */
import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  legacyAreaPrefixes,
  resolveStorageSettings,
  type LegacyAreaPrefix,
  type StorageArea,
} from '@indx-workspace/contracts/storage-settings';

import {
  DEFAULT_PROBE_TIMEOUT_MS,
  liveLegacyObjectCounter,
  objectStoreTarget,
  type LegacyObjectCounter,
} from '../validate.ts';
import type { DoctorCheck } from './checks.ts';
import type { DeploymentProfile } from '../profile.ts';

/** Stop counting an area here, and report "at least" this many. */
export const LEGACY_COUNT_CAP = 10_000;

/** Files under `directory` at any depth, counted until `cap`; a directory that is not there holds none. */
export async function countFiles(directory: string, cap: number): Promise<number> {
  let counted = 0;
  try {
    for await (const entry of await opendir(directory, { recursive: true })) {
      if (entry.isFile() && ++counted >= cap) break;
    }
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 'ENOENT') throw error;
  }
  return counted;
}

function row(
  subject: string,
  status: DoctorCheck['status'],
  detail: string,
  advice: string | null,
) {
  return { check: 'storage-layout', subject, status, detail, advice } as const;
}

function notCounted(subject: string, reason: string): DoctorCheck {
  return row(
    subject,
    'warn',
    `not counted: ${reason}`,
    'Run doctor where the storage is reachable, or check the old layout from the server host.',
  );
}

function counted(subject: StorageArea, count: number): DoctorCheck {
  if (count === 0) return row(subject, 'pass', 'no objects in the old layout', null);
  const amount = count >= LEGACY_COUNT_CAP ? 'at least ' : '';
  const noun = count === 1 ? 'object' : 'objects';
  return row(
    subject,
    'warn',
    `${amount}${count.toLocaleString('en-US')} ${noun} in the old layout`,
    // `AW_STORAGE_MIGRATE=copy` gives each object a new name but keeps the old one, so this count
    // falls only when `AW_STORAGE_MIGRATE=finalize` checks every copy and removes the old objects.
    'Run the server with AW_STORAGE_MIGRATE=copy; the old objects stay until you run it once with AW_STORAGE_MIGRATE=finalize, which checks every copy first.',
  );
}

/** The bucket key prefix of an old-layout entry: the URL's own prefix, then the area's. */
function bucketPrefix(entry: LegacyAreaPrefix): string {
  const own = 'prefix' in entry.location ? entry.location.prefix : '';
  return `${[own, entry.prefix].filter((part) => part !== '').join('/')}/`;
}

/**
 * One row per area that has an old layout. No row when no storage is set or the setting is
 * refused: the `storage` check already says so.
 *
 * `objectsAnswered` is whether the `stores` check reached the object store, so a bucket is listed
 * only where that probe already got through with the deployment's credentials.
 */
// @story US-STO-13
export async function checkStorageLayout(
  environment: Readonly<Record<string, string | undefined>>,
  profile: DeploymentProfile | null,
  objectsAnswered: boolean,
  options: {
    readonly layout?: LegacyObjectCounter;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  },
): Promise<readonly DoctorCheck[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const counter = options.layout ?? liveLegacyObjectCounter(timeoutMs);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const target = profile === null || !objectsAnswered ? null : objectStoreTarget(environment);

  const entries = legacyAreaPrefixes(resolveStorageSettings(environment));
  return Promise.all(
    entries.map(async (entry): Promise<DoctorCheck> => {
      try {
        // storage-bridge(#1699): old object naming
        const { location } = entry;
        if (location.kind === 'file') {
          const root = await stat(location.root).catch(() => null);
          return root?.isDirectory() === true
            ? counted(
                entry.area,
                await countFiles(path.join(location.root, entry.prefix), LEGACY_COUNT_CAP),
              )
            : notCounted(entry.area, 'the storage root is not on this host');
        }
        if (location.kind === 'azblob') {
          return notCounted(entry.area, 'Azure Blob is reached through managed identity');
        }
        if (target === null || target.bucket !== location.bucket) {
          return notCounted(entry.area, 'the object store did not answer from this host');
        }
        return counted(
          entry.area,
          await counter.bucket(target, bucketPrefix(entry), LEGACY_COUNT_CAP, signal),
        );
      } catch {
        return notCounted(entry.area, 'the old layout could not be listed');
      }
    }),
  );
}
