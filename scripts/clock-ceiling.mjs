#!/usr/bin/env node
// The clock ceiling may only go down (refactoring plan §07). scripts/check-clock-ceiling.mjs holds
// the code to the ceiling in scripts/clock-ceiling.json; what it cannot see is that ceiling raised
// in the same diff as a new call, so CI compares it with the base, as
// scripts/check-lint-baseline.mjs does for eslint-suppressions.json:
//
//   node scripts/clock-ceiling.mjs <base clock-ceiling.json> <head clock-ceiling.json>
//
// A missing base file means the base has no ceiling yet (the change that introduces it) and passes.
// Node built-ins only: it runs in the fast-checks job, before any dependency is installed.
import console from 'node:console';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const CEILING_FILE = 'scripts/clock-ceiling.json';

/**
 * The `ceiling` of a ceiling document (this one, or scripts/duration-ceiling.json).
 * @param {string} text
 * @param {string} [file] the document's path, for the error
 * @returns {number}
 */
export function parseCeiling(text, file = CEILING_FILE) {
  /** @type {unknown} */
  const document = JSON.parse(text);
  const ceiling =
    typeof document === 'object' && document !== null && 'ceiling' in document
      ? document.ceiling
      : undefined;
  if (typeof ceiling !== 'number' || !Number.isInteger(ceiling) || ceiling < 0) {
    throw new Error(`${file} needs a non-negative integer "ceiling"`);
  }
  return ceiling;
}

/** @returns {number} the ceiling committed in this checkout */
export function readCeiling() {
  return parseCeiling(readFileSync(CEILING_FILE, 'utf8'));
}

/**
 * @param {number | undefined} base the base's ceiling, or undefined when the base has none
 * @param {number} head this change's ceiling
 * @returns {string | null} why the ceiling grew, or null when it did not
 */
export function grown(base, head) {
  if (base === undefined || head <= base) return null;
  return `the clock ceiling grew from ${base} to ${head}; take the time from a Clock and ids from an IdGenerator instead of raising ${CEILING_FILE}.`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [basePath, headPath] = process.argv.slice(2);
  if (basePath === undefined || headPath === undefined) {
    console.error('usage: clock-ceiling.mjs <base clock-ceiling.json> <head clock-ceiling.json>');
    process.exit(2);
  }
  const base = existsSync(basePath) ? parseCeiling(readFileSync(basePath, 'utf8')) : undefined;
  const failure = grown(base, parseCeiling(readFileSync(headPath, 'utf8')));
  if (failure !== null) {
    console.error(failure);
    process.exit(1);
  }
  console.log(
    base === undefined
      ? 'The base has no clock ceiling; this change introduces it.'
      : 'The clock ceiling did not grow.',
  );
}
