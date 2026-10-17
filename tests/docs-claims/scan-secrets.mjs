#!/usr/bin/env node
/* global console */
/**
 * Fails when an Anthropic API key could be in what a run left behind (issue #881): any text file
 * under the files and directories given holds `sk-ant-` followed by key characters. The docs'
 * placeholder `sk-ant-...` has none, so it passes. Prints `file:line` only, never the match.
 *
 *   node tests/docs-claims/scan-secrets.mjs <file or directory>...
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const KEY = /sk-ant-[A-Za-z0-9_-]{8,}/u;

/**
 * @param {string} text
 * @returns {number[]} the 1-based lines that hold a key
 */
export function keyLines(text) {
  return text.split(/\r?\n/u).flatMap((line, index) => (KEY.test(line) ? [index + 1] : []));
}

/**
 * @param {string} location a file or a directory; one that does not exist holds no key
 * @returns {string[]} `file:line` for each key found in it
 */
export function findKeys(location) {
  const stat = statSync(location, { throwIfNoEntry: false });
  if (stat === undefined) return [];
  if (stat.isFile()) {
    return keyLines(readFileSync(location, 'latin1')).map((line) => `${location}:${String(line)}`);
  }
  return readdirSync(location).flatMap((name) => findKeys(path.join(location, name)));
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const directories = process.argv.slice(2);
  if (directories.length === 0) {
    console.error('usage: node tests/docs-claims/scan-secrets.mjs <directory>...');
    process.exitCode = 2;
  } else {
    const found = directories.flatMap((directory) => findKeys(directory));
    for (const place of found) console.error(`an Anthropic API key is at ${place}`);
    console.log(`scanned ${directories.join(', ')}: ${String(found.length)} key(s) found`);
    process.exitCode = found.length === 0 ? 0 : 1;
  }
}
