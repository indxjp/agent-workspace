/* global process */

/**
 * The one folder `file://` storage connections may name in the browser suite.
 * `playwright.config.ts` sets `AW_STORAGE_CONNECTION_FILE_ROOTS` (and creates the folder) before
 * the servers start, so the servers and every worker, which evaluates the config again, agree on
 * it. A module of its own so both storage specs read it the same way.
 */
export function storageConnectionFileRoot() {
  const root = process.env['AW_STORAGE_CONNECTION_FILE_ROOTS'];
  if (root === undefined || root === '' || root.includes(',')) {
    throw new Error('AW_STORAGE_CONNECTION_FILE_ROOTS must name exactly one folder.');
  }
  return root;
}
