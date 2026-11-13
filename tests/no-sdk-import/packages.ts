import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, RESEARCH_FIXTURE_ROOT, SDK_PACKAGES } from './boundaries.js';

/** The canonical location of a path: symlinks followed, so the pnpm store and its links agree. */
export function realPath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

export function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** The `name` of the nearest `package.json` at or above the directory, or `null`. */
function nearestManifestName(startDir: string, resolvedFile: string): string | null {
  let dir = startDir;
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      const name = asRecord(parseManifest(manifest, resolvedFile))?.['name'];
      if (typeof name === 'string') return name;
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function parseManifest(manifest: string, resolvedFile: string): unknown {
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `${manifest} could not be parsed, so this gate cannot say which package owns ${resolvedFile}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * The name of the package that owns a resolved file, read from the `package.json` a resolver
 * would read it from.
 *
 * This replaces "does the specifier text start with the package name": a vendored copy of the
 * SDK, the pnpm content-addressed store, a workspace symlink and a `paths` alias all land on a
 * file whose owning manifest says `@anthropic-ai/claude-agent-sdk`, and none has to be
 * enumerated.
 */
export function owningPackageName(resolvedFile: string): string | null {
  return nearestManifestName(path.dirname(path.resolve(resolvedFile)), resolvedFile);
}

/** Is this resolved file part of a package §42 confines? */
export function sdkOwns(resolvedFile: string): boolean {
  const owner = owningPackageName(resolvedFile);
  return owner !== null && SDK_PACKAGES.has(owner);
}

const FIXTURE_ROOT_ABSOLUTE = realPath(path.join(REPO_ROOT, RESEARCH_FIXTURE_ROOT));

/** Is this resolved file inside the research-fixture tree? Path containment, not text. */
export function insideResearchFixtures(resolvedFile: string): boolean {
  const relative = path.relative(FIXTURE_ROOT_ABSOLUTE, path.resolve(resolvedFile));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The package a **bare** specifier names, or `null` when the specifier does not name one.
 *
 * `null` is the answer that matters, and each arm returns it for a positive reason:
 *
 *   * a **relative** specifier names a file, so one that resolves nowhere is a broken link and
 *     stays a hard failure, fixtures included (ADR-0032 clause 2);
 *   * an **absolute** specifier names a path on the machine running the gate;
 *   * a **`#`-prefixed** specifier is a subpath import out of an `imports` map in this
 *     repository, so one that does not resolve is a manifest defect, not a package elsewhere;
 *   * a specifier carrying a **scheme** is a URL (`node:` is decided as a builtin before this);
 *   * a lone **`@scope`** with no name is not a legal package specifier.
 */
export function packageNameOf(specifier: string): string | null {
  if (specifier === '') return null;
  if (specifier.startsWith('.') || specifier.startsWith('#')) return null;
  if (specifier.startsWith('/') || specifier.startsWith('\\')) return null;
  if (path.isAbsolute(specifier)) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) return null;
  const [first, second] = specifier.split('/');
  if (first === undefined || first === '') return null;
  if (!first.startsWith('@')) return first;
  if (first.length < 2 || second === undefined || second === '') return null;
  return `${first}/${second}`;
}

/** Characters that continue a package name, so a match ending on one is a *different* package. */
const PACKAGE_NAME_CONTINUES = /[A-Za-z0-9._-]/;

function continuesAName(character: string): boolean {
  return character !== '' && PACKAGE_NAME_CONTINUES.test(character);
}

/**
 * Does this README name this package?
 *
 * A containment test with boundaries, and the boundaries are the whole of it: a plain `includes`
 * would let `@modelcontextprotocol/sdk-experimental` document `@modelcontextprotocol/sdk`, which
 * is the fail-open shape this clause exists to stop. A match counts when the character before it
 * does not continue a name (and is not `/`, which would make it the tail of a longer path) and
 * the character after it does not either. `@` and `/` after the name must still count:
 * `…/sdk@1.30.0` is a version pin and `…/sdk/client/stdio.js` is a subpath.
 */
export function namesPackage(text: string, packageName: string): boolean {
  for (let from = 0; ;) {
    const at = text.indexOf(packageName, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : (text[at - 1] ?? '');
    const after = text[at + packageName.length] ?? '';
    if (!continuesAName(before) && before !== '/' && !continuesAName(after)) return true;
    from = at + 1;
  }
}
