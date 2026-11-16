/**
 * @typedef {import('./extract.mjs').Claim} Claim
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './run-config.mjs';

/** @param {string} file @returns {string | undefined} */
export function readRepositoryFile(file) {
  try {
    return readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    return undefined;
  }
}

/** @param {string} page @param {string} needle */
export function lineOf(page, needle) {
  const index = (readRepositoryFile(page) ?? '').split('\n').findIndex((l) => l.includes(needle));
  return index < 0 ? 1 : index + 1;
}

/** @param {Claim} claim */
export const whereOf = (claim) => `${claim.page}:${String(claim.line)}`;

/** @param {string} body */
export const firstLine = (body) => body.split('\n').find((line) => line.trim() !== '') ?? '';
