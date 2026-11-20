// Whether a diff reaches the Lean model (ci.yml `formal`, docs/adr/0062): its sources (contracts,
// SDK, aw, the server domains and the core, gateway, runtime and runner code it mirrors), the
// conformance suite, the generators, and the documents the model cites. Read by `formal`'s scope
// step, which has a diff base only on a `ci:full` pull request since `formal` joined the heavy tier
// (ADR-0053 Amendment 2026-11-19c); the tests in ci-plan.test.mjs hold the pattern.
//
// Usage: node scripts/ci/formal-scope.mjs <diff base>   prints `applies=true` or `applies=false`
// (the step appends it to $GITHUB_OUTPUT); it exits non-zero if git fails, never answering false.
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const FORMAL_SCOPE =
  /^(formal\/|packages\/(contracts|sdk|aw|core|gateway|runtime)\/src\/|packages\/engine[^/]*\/src\/|migrations\/|apps\/web\/server\/|apps\/runner\/src\/|apps\/(web|runner)\/formal\/|tests\/formal\/|scripts\/formal\/|docs\/20-design\/formal\/|docs\/sdk\/|docs\/adr\/|docs\/spec\.md$|docs\/20-design\/architecture\.md$|\.github\/workflows\/ci\.yml$|package\.json$|pnpm-lock\.yaml$)/u;

/** @param {readonly string[]} files repository-relative paths @returns {boolean} */
export function reachesFormal(files) {
  return files.some((file) => FORMAL_SCOPE.test(file));
}

/** @param {string} base @returns {boolean} whether `base...HEAD` reaches the model */
export function formalApplies(base) {
  const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return reachesFormal(changed.split('\n').filter((line) => line !== ''));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(invokedPath).href === import.meta.url) {
  const base = process.argv[2];
  if (base === undefined || base === '') {
    console.error('usage: node scripts/ci/formal-scope.mjs <diff base>');
    process.exit(2);
  }
  console.log(`applies=${String(formalApplies(base))}`);
}
