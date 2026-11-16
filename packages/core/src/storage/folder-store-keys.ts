import {
  addressableObjectName,
  toObjectKey,
  toObjectPrefix,
  UnsafeObjectKeyError,
} from './key-safety.js';

import { onWindows, windowsNameProblem, type FolderStoreOptions } from './folder-store-state.js';

export function createFolderKeys(options: FolderStoreOptions) {
  const windowsNames = options.windowsNames ?? onWindows;

  /** `key`'s segments, when Windows would read each as itself; otherwise a key-guard refusal. */
  function windowsSafe(key: string, segments: string[]): string[] {
    if (!windowsNames) return segments;
    for (const segment of segments) {
      const problem = windowsNameProblem(segment);
      if (problem !== null) {
        throw new UnsafeObjectKeyError(
          'windows-name',
          key,
          `contains the segment ${JSON.stringify(segment)}: ${problem} on Windows`,
        );
      }
    }
    return segments;
  }
  const segmentsOf = (key: string): string[] => windowsSafe(key, toObjectKey(key).split('/'));
  /** A listing prefix, checked like a key; `''` is the root. */
  const prefixOf = (prefix: string): string => {
    const safe = toObjectPrefix(prefix);
    if (safe !== '') windowsSafe(prefix, safe.split('/'));
    return safe;
  };
  /** Whether a name found on disk may be listed: a key the guards accept. */
  const isListable = (key: string): boolean =>
    addressableObjectName(key) !== null &&
    (!windowsNames || key.split('/').every((segment) => windowsNameProblem(segment) === null));

  return { segmentsOf, prefixOf, isListable };
}
