import { fileURLToPath, pathToFileURL } from 'node:url';

import { RESEARCH_FIXTURE_ROOT, SDK_PACKAGES } from './boundaries.js';
import { insideResearchFixtures, realPath, sdkOwns } from './packages.js';
import { scanModuleSource, type Undecidable } from './scan.js';

/**
 * Markup is a URL arm, not a module-specifier arm. ADR-0030 binds the module-specifier question;
 * a `src`/`href` in an HTML document is a **URL** a browser resolves against the document's URL,
 * and there is no `ts.resolveModuleName` for `https://cdn.example/…`. So markup references are
 * resolved with `new URL(reference, documentUrl)` and then decided: a `file:` URL by the same
 * path comparison every other reference gets, and a remote URL by whether its resolved *path*
 * names the package, the one place a name survives, which the ADR declares as a gap.
 */

/** `src="…"` / `href="…"` — the way an HTML page names a resource without `import`. */
const MARKUP_ATTRIBUTE_SPECIFIER = /\b(?:src|href)\s*=\s*['"]([^'"\n]+)['"]/g;

/** The body of every `<script>` element, which is module source a browser runs. */
const MARKUP_SCRIPT_BODY = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;

/** What a markup reference points at once the URL algorithm has been applied to it. */
export type MarkupTarget =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'remote'; readonly href: string; readonly pathname: string }
  | { readonly kind: 'unreadable'; readonly reason: string };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileTarget(url: URL, reference: string): MarkupTarget {
  const bare = new URL(url.href);
  bare.hash = '';
  bare.search = '';
  try {
    return { kind: 'file', path: realPath(fileURLToPath(bare)) };
  } catch (error) {
    return {
      kind: 'unreadable',
      reason: `the reference ${JSON.stringify(reference)} resolved to ${bare.href}, which names no path this gate can compare: ${describeError(error)}`,
    };
  }
}

/**
 * Resolve a markup reference the way a browser does: as a URL against the document's own URL. A
 * `file:` result is a path in this checkout; a result on another origin is a resource this gate
 * has no resolver for, so the only thing it can compare is the URL's own resolved path.
 */
export function resolveMarkupReference(absoluteDocument: string, reference: string): MarkupTarget {
  let url: URL;
  try {
    url = new URL(reference, pathToFileURL(absoluteDocument));
  } catch (error) {
    return {
      kind: 'unreadable',
      reason: `the reference ${JSON.stringify(reference)} is not a URL a browser could resolve against this document: ${describeError(error)}`,
    };
  }
  if (url.protocol === 'file:') return fileTarget(url, reference);
  return { kind: 'remote', href: url.href, pathname: decodeURIComponent(url.pathname) };
}

/**
 * Does a path name a package by its directory segments? Used only on a **resolved** URL path,
 * never on the text a reference was written with. `@anthropic-ai/claude-agent-sdk` is two
 * segments, so this looks for those two in order rather than for a substring.
 */
function pathNamesPackage(candidate: string, packageName: string): boolean {
  const wanted = packageName.split('/');
  const segments = candidate.split(/[\\/]+/).filter((segment) => segment.length > 0);
  for (let i = 0; i + wanted.length <= segments.length; i += 1) {
    if (wanted.every((segment, j) => segments[i + j] === segment)) return true;
  }
  return false;
}

function pathNamesAnySdk(candidate: string): boolean {
  return [...SDK_PACKAGES].some((name) => pathNamesPackage(candidate, name));
}

export function markupTargetIsSdk(target: MarkupTarget): boolean {
  if (target.kind === 'file') return sdkOwns(target.path) || pathNamesAnySdk(target.path);
  if (target.kind === 'remote') return pathNamesAnySdk(target.pathname);
  return false;
}

export function markupTargetIsFixture(target: MarkupTarget): boolean {
  if (target.kind === 'file') {
    return (
      insideResearchFixtures(target.path) || pathNamesPackage(target.path, RESEARCH_FIXTURE_ROOT)
    );
  }
  if (target.kind === 'remote') return pathNamesPackage(target.pathname, RESEARCH_FIXTURE_ROOT);
  return false;
}

/** Every reference an HTML document makes: its `src`/`href` attributes and its inline scripts. */
export function markupReferences(
  file: string,
  source: string,
): { references: string[]; undecidable: Undecidable[] } {
  const references: string[] = [];
  const undecidable: Undecidable[] = [];
  for (const match of source.matchAll(MARKUP_ATTRIBUTE_SPECIFIER)) {
    const reference = match[1];
    if (reference !== undefined) references.push(reference);
  }
  for (const match of source.matchAll(MARKUP_SCRIPT_BODY)) {
    const body = match[1];
    if (body === undefined || body.trim() === '') continue;
    // The body is JavaScript, so the syntax tree finds its references; they are *resolved* as
    // URLs, because a browser runs them. The pseudo-name ends in `.js` so the body parses as
    // JavaScript rather than TypeScript.
    const scan = scanModuleSource(`${file}#inline-script.js`, body);
    undecidable.push(...scan.undecidable.map((entry) => ({ file, reason: entry.reason })));
    references.push(...scan.references.map((reference) => reference.specifier));
  }
  return { references, undecidable };
}
