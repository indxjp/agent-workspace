/**
 * Why a storage connection's operation failed, read from the error's status, class or errno code
 * alone (the storage design, §05 Security). Never the message or `cause`, which may echo the
 * provider's reply, a key or a path.
 */
import { FolderPathError, FolderStoreError, FolderWalkLimitError } from './folder-store.js';

/**
 * The HTTP status a storage provider's error carries: S3 `$metadata.httpStatusCode`, Azure and the
 * GCS store's safe error `statusCode`, or a numeric `code`. Only the number is read, never the
 * message or `cause`, which may echo the provider's reply.
 */
export function storageProviderStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const metadata: unknown = Reflect.get(error, '$metadata');
  const candidates: unknown[] = [
    typeof metadata === 'object' && metadata !== null
      ? Reflect.get(metadata, 'httpStatusCode')
      : undefined,
    Reflect.get(error, 'statusCode'),
    Reflect.get(error, 'code'),
  ];
  return candidates.find((value): value is number => typeof value === 'number') ?? null;
}

/** How a connection's operation failed, from the provider's status alone. */
export type StorageRefusalClass = 'forbidden' | 'not_found' | 'unreachable';

/** How a `file` connection's folder failed, from the error's class and errno code alone. */
export interface FolderFailure {
  readonly refusal: StorageRefusalClass;
  /** `outside_root`, `walk_limit`, or the errno code. Never a key or a path. */
  readonly reason: string;
}

/** A `file` connection's own failure (`folder-store.ts`), or `null` for any other error. */
export function folderFailure(error: unknown): FolderFailure | null {
  if (error instanceof FolderPathError) return { refusal: 'forbidden', reason: 'outside_root' };
  if (error instanceof FolderWalkLimitError) {
    return { refusal: 'unreachable', reason: 'walk_limit' };
  }
  if (!(error instanceof FolderStoreError)) return null;
  const { code } = error;
  if (code === 'EACCES' || code === 'EPERM') return { refusal: 'forbidden', reason: code };
  if (code === 'ENOENT' || code === 'ENOTDIR') return { refusal: 'not_found', reason: code };
  return { refusal: 'unreachable', reason: code };
}

export function storageRefusalClass(error: unknown): StorageRefusalClass {
  const folder = folderFailure(error);
  if (folder !== null) return folder.refusal;
  const status = storageProviderStatus(error);
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  return 'unreachable';
}
