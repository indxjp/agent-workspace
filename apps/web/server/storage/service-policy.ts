import { createHash } from 'node:crypto';
import { type StorageArea } from '@agent-workspace/core/storage';
import {
  PRESIGNED_URL_DEFAULT_TTL_SECONDS,
  PRESIGNED_URL_MAX_TTL_SECONDS,
  PRESIGNED_URL_MIN_TTL_SECONDS,
} from '@indx-workspace/contracts/files';
import { type CatalogFile } from './store';
import { type ReplacePolicy } from './service-contract';

/**
 * A name-based UUID (RFC 9562 version 8, from SHA-256 of `parts`): the same parts give the same
 * id, so an audit write retried under it is the same row.
 */
export function auditKey(parts: readonly string[]): string {
  const hash = createHash('sha256').update(JSON.stringify(parts)).digest().subarray(0, 16);
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x80, 6);
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** What makes an upload one event: the object id it confirmed (a row with none: its id). */
export const uploadOccurrence = (row: Pick<CatalogFile, 'id' | 'objectId'>): string =>
  row.objectId ?? row.id;

/** The lifetime a link is signed for, or `null` when it is outside the contract's bounds. */
export function linkLifetime(ttlSeconds: number | undefined): number | null {
  const seconds = ttlSeconds ?? PRESIGNED_URL_DEFAULT_TTL_SECONDS;
  return Number.isInteger(seconds) &&
    seconds >= PRESIGNED_URL_MIN_TTL_SECONDS &&
    seconds <= PRESIGNED_URL_MAX_TTL_SECONDS
    ? seconds
    : null;
}

/**
 * Whether a pending replacement may overwrite `target`, the ready file its reserve locked. A
 * replacement the catalog named no target for is refused rather than decided on a path.
 */
export async function mayReplace(
  replace: boolean | ReplacePolicy,
  target: CatalogFile | undefined,
): Promise<boolean> {
  if (target === undefined) return false;
  return typeof replace === 'boolean' ? replace : replace(target);
}

/**
 * Whether a row answers a read for `area`. A `staging` row is never listed. An `artifacts` row
 * (a run output) lists as `files`: the area only decides which folder its object sits in.
 */
export function listedIn(row: CatalogFile, area: StorageArea): boolean {
  const own = row.area ?? 'files';
  return own !== 'staging' && (own === area || (own === 'artifacts' && area === 'files'));
}
