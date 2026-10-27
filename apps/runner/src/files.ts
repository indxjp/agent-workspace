import {
  ArchiveValidationError,
  archiveWorkspacePaths,
  bytesToStream,
  extractUstar,
  readStream,
} from '@agent-workspace/runtime/transfer';

/** Runner side of the §14.3 `/files` endpoints; the codec and confinement live in packages/runtime. */
export function hydrateWorkspace(root: string, archive: Uint8Array): Promise<readonly string[]> {
  return extractUstar(bytesToStream(archive), root);
}

export async function collectWorkspace(
  root: string,
  paths: readonly string[],
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<Uint8Array> {
  // Kept here so the runner's 400 message stays word for word what it was.
  if (paths.length === 0) {
    throw new ArchiveValidationError('at least one path query parameter is required');
  }
  return readStream(await archiveWorkspacePaths(root, paths, { maxBytes }));
}
