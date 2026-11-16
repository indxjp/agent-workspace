import path from 'node:path';
import { ArchiveValidationError } from './model.js';

function unsafePath(value: string, reason = ''): ArchiveValidationError {
  return new ArchiveValidationError(`unsafe archive path ${JSON.stringify(value)}${reason}`);
}

/** The value, then each percent-decoding of it (at most three). Decoding stops at a malformed `%`. */
function percentSpellings(value: string): { spellings: string[]; malformed: boolean } {
  const spellings = [value];
  let current = value;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return { spellings, malformed: true };
    }
    if (next === current) break;
    spellings.push(next);
    current = next;
  }
  return { spellings, malformed: false };
}

/** Refuse one spelling of a path that is empty, absolute or climbs out. Returns it with `\` folded. */
function assertSafeSpelling(spelling: string, original: string): string {
  const folded = spelling.replaceAll('\\', '/');
  if (folded.length === 0 || folded.includes('\0')) throw unsafePath(original);
  if (folded.startsWith('/') || /^[A-Za-z]:/u.test(folded)) {
    throw unsafePath(original, ': absolute paths are forbidden');
  }
  if (folded.split('/').some((segment) => segment === '..')) {
    throw unsafePath(original, ': parent traversal is forbidden');
  }
  return folded;
}

function tidyPath(candidate: string, original: string): string {
  const normalized = path.posix.normalize(candidate).replace(/^\.\//u, '').replace(/\/$/u, '');
  if (normalized.length === 0 || normalized === '.' || normalized.startsWith('../')) {
    throw unsafePath(original);
  }
  return normalized;
}

/**
 * Normalize an untrusted request path (a `?path=` parameter) and prove that it stays relative.
 * It percent-decodes and folds `\`, so it must not be applied to a real on-disk file name.
 */
// @story US-STO-06
export function normalizeArchivePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw unsafePath(value);
  }
  const { spellings, malformed } = percentSpellings(value);
  if (malformed) throw unsafePath(value, ': malformed percent encoding');
  const tidied = tidyPath(assertSafeSpelling(spellings.at(-1) ?? value, value), value);
  // Tidying can expose a drive letter (`./C:/x`), and a `%` that survives the last decoding means
  // the encoding is nested deeper than decoded, so a consumer decoding once more could climb out.
  assertSafeSpelling(tidied, value);
  if (tidied.includes('%')) throw unsafePath(value, ': percent encoding nested too deeply');
  return tidied;
}

/**
 * Validate the name of a tar member and return it literally: `50%.txt` and `a%2Eb` are real file
 * names. The name is refused when it, or any percent-decoded or `\`-folded spelling of it, is
 * unsafe, so a consumer that decodes it later still cannot be walked out of the workspace.
 */
export function archiveMemberPath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw unsafePath(value);
  }
  for (const spelling of percentSpellings(value).spellings) assertSafeSpelling(spelling, value);
  return tidyPath(value, value);
}

/** One entry name read from a directory: a literal that must be a single path segment. */
export function assertSegment(name: string, parent: string): void {
  if (name.length === 0 || name === '.' || name === '..' || /[/\0]/u.test(name)) {
    throw unsafePath(`${parent}/${name}`);
  }
}

/** Resolve an already-validated relative path under `root` and prove it did not escape. */
export function resolveWithin(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relativePath.split('/'));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new ArchiveValidationError(`archive member escapes workspace: ${relativePath}`);
  }
  return resolved;
}
