#!/usr/bin/env node
/* global console */
/**
 * Fails when a credential could be in what a run left behind (issue #881): any text file under the
 * files and directories given holds a key-shaped string, an Anthropic key (`sk-ant-` followed by key
 * characters) first, then the shapes a model or a tool could just as well echo (EVL-04): other
 * providers' keys, this product's own API keys and Owner session, tokens, and private key blocks.
 * The docs' placeholder `sk-ant-...` has no key characters, so it passes. Prints `file:line` only,
 * never the match.
 *
 *   node tests/docs-claims/scan-secrets.mjs <file or directory>...
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** One entry per shape; a line that matches any of them holds a key. */
const KEY_SHAPES = [
  // Anthropic (the shape the docs and the e2e fake key use).
  /sk-ant-[A-Za-z0-9_-]{8,}/u,
  // OpenAI and compatible providers: `sk-`, `sk-proj-`, `sk-svcacct-`, at the start of a word.
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{24,}/u,
  // Google API keys, AWS access key ids, Slack tokens.
  /\bAIza[A-Za-z0-9_-]{35}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
  // GitHub tokens.
  /\bgh[pousr]_[A-Za-z0-9]{30,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/u,
  // This product's API keys (`ak_live_…`), its Console-minted tokens (`awt_live_…`) and a session cookie.
  /\bak_live_[A-Za-z0-9_-]{8,}/u,
  /\bawt_live_[A-Za-z0-9_-]{8,}/u,
  /\baw_session=[A-Za-z0-9._%~+/-]{16,}/u,
  // A bearer credential and a JSON web token.
  /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
  // A PEM private key block.
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/u,
];

/**
 * @param {string} text
 * @returns {number[]} the 1-based lines that hold a key
 */
export function keyLines(text) {
  return text
    .split(/\r?\n/u)
    .flatMap((line, index) => (KEY_SHAPES.some((shape) => shape.test(line)) ? [index + 1] : []));
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
