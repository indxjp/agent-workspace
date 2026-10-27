import { log } from '../telemetry/logger';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

type VerificationRecord = Readonly<{
  fingerprint: string;
  configurationKey: string;
  verifiedAt: string;
  expiresAt: string;
}>;

type VerificationDocument = Readonly<{
  schemaVersion: 1;
  drivers: Readonly<Record<string, VerificationRecord>>;
}>;

export interface RuntimeVerificationCache {
  wasVerified(driverId: string, configurationKey: string, now?: Date): boolean;
  /** A pass was ever recorded for the driver, whatever its configuration or expiry (BH061-002). */
  hasPassed(driverId: string): boolean;
  record(
    driverId: string,
    configurationKey: string,
    verification: Readonly<{ fingerprint: string; verifiedAt: string; expiresAt: string }>,
  ): Promise<void>;
}

function validRecord(value: unknown): value is VerificationRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ['fingerprint', 'configurationKey', 'verifiedAt', 'expiresAt'].every(
    (key) => typeof record[key] === 'string' && record[key].length > 0,
  );
}

async function readDocument(file: string): Promise<VerificationDocument> {
  try {
    const decoded = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('runtime verification document must be an object');
    }
    const candidate = decoded as { schemaVersion?: unknown; drivers?: unknown };
    if (
      candidate.schemaVersion !== 1 ||
      candidate.drivers === null ||
      typeof candidate.drivers !== 'object' ||
      Array.isArray(candidate.drivers)
    ) {
      throw new Error('runtime verification document has an unsupported schema');
    }
    const drivers = Object.fromEntries(
      Object.entries(candidate.drivers as Record<string, unknown>).filter((entry) =>
        validRecord(entry[1]),
      ),
    ) as Record<string, VerificationRecord>;
    return { schemaVersion: 1, drivers };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: 1, drivers: {} };
    }
    throw new Error(`runtime verification state is unreadable at ${file}`, { cause: error });
  }
}

/** Load a fail-closed verification cache and persist every later success with atomic replacement. */
export async function loadRuntimeVerificationCache(
  file: string,
): Promise<RuntimeVerificationCache> {
  let document = await readDocument(file);
  let pending = Promise.resolve();
  let warnedReadOnly = false;
  return {
    wasVerified(driverId, configurationKey, now = new Date()) {
      const record = document.drivers[driverId];
      return (
        record !== undefined &&
        record.configurationKey === configurationKey &&
        Number.isFinite(Date.parse(record.verifiedAt)) &&
        Date.parse(record.expiresAt) > now.getTime()
      );
    },
    hasPassed(driverId) {
      return document.drivers[driverId] !== undefined;
    },
    async record(driverId, configurationKey, verification) {
      // `pending` must never settle into a rejected promise: every later call does
      // `pending.then(...)`, and `.then` on an already-rejected promise skips its callback and
      // just re-rejects, so a single transient failure here would silently and permanently stop
      // every future call from ever running its body. The queued step therefore always resolves
      // (never throws out of the chain) and reports its own outcome through the returned promise.
      const step = pending.then(async () => {
        const expiresAt = Date.parse(verification.expiresAt);
        const verifiedAt = Date.parse(verification.verifiedAt);
        if (
          !Number.isFinite(expiresAt) ||
          !Number.isFinite(verifiedAt) ||
          expiresAt <= verifiedAt
        ) {
          throw new Error('runtime verification has an invalid validity window');
        }
        document = {
          schemaVersion: 1,
          drivers: {
            ...document.drivers,
            [driverId]: { ...verification, configurationKey },
          },
        };
        try {
          await mkdir(path.dirname(file), { recursive: true });
          const temporary = `${file}.${randomUUID()}.tmp`;
          await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
            flag: 'wx',
            mode: 0o600,
          });
          await rename(temporary, file);
        } catch (error) {
          // The Helm chart runs web on a read-only root filesystem with no volume (an object store
          // is the only file store it serves), so there a verification lasts as long as the
          // process, as a per-pod volume would. Every other write failure still fails the record.
          if ((error as NodeJS.ErrnoException).code !== 'EROFS') throw error;
          if (!warnedReadOnly) {
            warnedReadOnly = true;
            log.warn(
              `runtime verifications are kept in memory only: ${path.dirname(file)} is read-only`,
            );
          }
        }
      });
      pending = step.catch(() => undefined);
      return step;
    },
  };
}
