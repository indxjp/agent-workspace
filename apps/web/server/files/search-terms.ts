/**
 * The one owner of how file search splits text into terms (ADR-0147, P8-4).
 *
 * PostgreSQL's parser does not segment Japanese and this platform assumes no extension, so the
 * text and the query are both reduced to the same terms here and handed to the `simple`
 * configuration: NFKC and lower case, then every run of Han, Hiragana or Katakana becomes
 * overlapping character bigrams (a single character stays whole), and every other letter or digit
 * run stays one word. `保守手順` is `保守 守手 手順`, and the query `手順` finds it. It mirrors
 * `tests/gallery/shared/jp-search.mjs`, which the gallery's own search tools used before this.
 *
 * ponytail: bigrams over-match short common pairs and need no dictionary; a morphological
 * analyser is the upgrade if precision matters more than a dependency-free install.
 */

import { isCanonicalFileScopePath } from '@indx-workspace/contracts/runs';

const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々`;
const SEGMENT = new RegExp(`[${CJK}]+|(?:(?![${CJK}])[\\p{L}\\p{N}])+`, 'gu');
const CJK_RUN = new RegExp(`^[${CJK}]`, 'u');
const MAX_WORD_CHARS = 128;

/** The terms of `text`, in order, with repeats. */
export function searchTerms(text: string): string[] {
  const terms: string[] = [];
  for (const segment of text.normalize('NFKC').toLowerCase().match(SEGMENT) ?? []) {
    const chars = [...segment];
    if (!CJK_RUN.test(segment)) {
      terms.push(chars.slice(0, MAX_WORD_CHARS).join(''));
    } else if (chars.length === 1) {
      terms.push(segment);
    } else {
      for (let index = 0; index + 1 < chars.length; index += 1) {
        terms.push(`${chars[index]}${chars[index + 1]}`);
      }
    }
  }
  return terms;
}

/**
 * A `to_tsquery('simple', …)` string: the terms of each run of the query joined by `<->` (so
 * `手順` inside `保守手順` must be adjacent bigrams), and the runs joined by `&`. `null` when the
 * query holds no term, which the caller answers as a bad query rather than as no result.
 * The output contains only terms and these operators, never user-typed tsquery syntax.
 */
export function toTsQuery(query: string): string | null {
  const runs: string[] = [];
  for (const run of query.split(/\s+/u)) {
    const terms = searchTerms(run);
    if (terms.length > 0) runs.push(terms.map(quoteTerm).join(' <-> '));
  }
  return runs.length > 0 ? runs.join(' & ') : null;
}

/**
 * Terms are letters and digits only, so quoting is for the grammar, not for safety. A lone CJK
 * character is a prefix (`'猫':*`) so it also finds the bigrams it starts, `猫で` in `黒猫です`.
 *
 * ponytail: a character that only ends a run (`猫` in `黒猫`) is still missed; indexing CJK
 * unigrams on the write side is the upgrade.
 */
function quoteTerm(term: string): string {
  return [...term].length === 1 && CJK_RUN.test(term) ? `'${term}':*` : `'${term}'`;
}

const SNIPPET_CHARS = 160;

/** About {@link SNIPPET_CHARS} characters of `text` around the first place a query term occurs. */
export function snippetAround(text: string, query: string): string {
  const flat = text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const word of query.normalize('NFKC').toLowerCase().split(/\s+/u)) {
    const found = word === '' ? -1 : lower.indexOf(word);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  const start = Math.max(0, Math.min(at === -1 ? 0 : at - 40, flat.length - SNIPPET_CHARS));
  const clipped = flat.slice(start, start + SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${clipped}${start + SNIPPET_CHARS < flat.length ? '…' : ''}`;
}

/** A grant names an exact file, or a folder whose whole subtree it covers. */
export function isGrantedPath(path: string, grants: readonly string[]): boolean {
  return grants.some((grant) => path === grant || path.startsWith(`${grant}/`));
}

/** The smallest grant set that covers the same paths: a path under a granted folder is dropped. */
export function grantRoots(
  entries: readonly { readonly kind: 'file' | 'directory'; readonly path: string }[],
): string[] {
  const folders = entries.filter((e) => e.kind === 'directory').map((e) => e.path);
  return entries
    .map((e) => e.path)
    .filter((path) => !folders.some((folder) => path.startsWith(`${folder}/`)));
}

interface GrantEntry {
  readonly kind: 'file' | 'directory';
  readonly path: string;
}

/**
 * A run's file grants narrowed to the caller's `fileScope` (ADR-0147, issue #1539): the entries a
 * scope path names or contains, and the scope paths that would widen the grants (not covered by
 * `grantRoots(entries)`, or not canonical). `kept` is always a subset of `entries`, so a hostile
 * path can only match nothing.
 */
export function narrowFileGrants<E extends GrantEntry>(
  entries: readonly E[],
  scope: readonly string[],
): { readonly kept: E[]; readonly widens: string[] } {
  const roots = grantRoots(entries);
  return {
    kept: entries.filter((entry) => isGrantedPath(entry.path, scope)),
    widens: scope.filter((path) => !isCanonicalFileScopePath(path) || !isGrantedPath(path, roots)),
  };
}
