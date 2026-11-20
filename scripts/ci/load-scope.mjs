// Whether a diff reaches the storage load test (ci.yml heavy-checks `tests` leg, the storage
// design §07 "Load test"): the storage code, the load harness, and the backend SDKs it streams
// through (@aws-sdk/client-s3, @azure/storage-blob, @google-cloud/storage), which change only
// through packages/core/package.json or pnpm-lock.yaml. A dependency bump that starts buffering a
// whole body must meet the flat-memory check before it merges, not in the nightly after it
// (ADR-0053 Amendment 2026-11-19f). The tests in ci-plan.test.mjs hold the pattern.
//
// Usage: node scripts/ci/load-scope.mjs <diff base>   prints `applies=true` or `applies=false`
// (the step appends it to $GITHUB_OUTPUT); it exits non-zero if git fails, never answering false.
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const STORAGE_LOAD_SCOPE =
  /^(packages\/core\/src\/storage\/|tests\/load\/|packages\/core\/package\.json$|pnpm-lock\.yaml$)/u;

/** @param {readonly string[]} files repository-relative paths @returns {boolean} */
export function reachesStorageLoad(files) {
  return files.some((file) => STORAGE_LOAD_SCOPE.test(file));
}

/** @param {string} base @returns {boolean} whether `base...HEAD` reaches the load test */
export function storageLoadApplies(base) {
  const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return reachesStorageLoad(changed.split('\n').filter((line) => line !== ''));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  const base = process.argv[2];
  if (base === undefined || base === '') {
    console.error('usage: node scripts/ci/load-scope.mjs <diff base>');
    process.exit(2);
  }
  console.log(`applies=${String(storageLoadApplies(base))}`);
}
