#!/usr/bin/env node
// The duration ceiling may only go down (refactoring part 03, step 8). It is the clock ceiling's
// twin: scripts/check-duration-ceiling.mjs holds the code to scripts/duration-ceiling.json, and CI
// compares that ceiling with the base's, so it cannot be raised in the same diff as a new literal:
//
//   node scripts/duration-ceiling.mjs <base duration-ceiling.json> <head duration-ceiling.json>
//
// A missing base file means the base has no ceiling yet (the change that introduces it) and passes.
// Node built-ins only: it runs in the fast-checks job, before any dependency is installed.
import console from 'node:console';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { parseCeiling } from './clock-ceiling.mjs';

export const DURATION_CEILING_FILE = 'scripts/duration-ceiling.json';

/** @returns {number} the duration ceiling committed in this checkout */
export function readDurationCeiling() {
  return parseCeiling(readFileSync(DURATION_CEILING_FILE, 'utf8'), DURATION_CEILING_FILE);
}

/**
 * @param {number | undefined} base the base's ceiling, or undefined when the base has none
 * @param {number} head this change's ceiling
 * @returns {string | null} why the ceiling grew, or null when it did not
 */
export function grown(base, head) {
  if (base === undefined || head <= base) return null;
  return `the duration ceiling grew from ${base} to ${head}; name the value in a const instead of raising ${DURATION_CEILING_FILE}.`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [basePath, headPath] = process.argv.slice(2);
  if (basePath === undefined || headPath === undefined) {
    console.error(
      'usage: duration-ceiling.mjs <base duration-ceiling.json> <head duration-ceiling.json>',
    );
    process.exit(2);
  }
  const read = (/** @type {string} */ file) => parseCeiling(readFileSync(file, 'utf8'), file);
  const base = existsSync(basePath) ? read(basePath) : undefined;
  const failure = grown(base, read(headPath));
  if (failure !== null) {
    console.error(failure);
    process.exit(1);
  }
  console.log(
    base === undefined
      ? 'The base has no duration ceiling; this change introduces it.'
      : 'The duration ceiling did not grow.',
  );
}
