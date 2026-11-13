/**
 * How the app kit's page search splits text into terms (ADR-0147's lexical search, issue #1520).
 * Pure.
 *
 * PostgreSQL's parser does not segment Japanese and an app's database is assumed to have no
 * extension, so the text and the query are both reduced to the same terms here and handed to the
 * `simple` configuration: NFKC and lower case, then every run of Han, Hiragana or Katakana becomes
 * overlapping character bigrams (a single character stays whole), and every other letter or digit
 * run stays one word. `保守手順` is `保守 守手 手順`, and the query `手順` finds it.
 *
 * It is a port of the platform's file-search tokeniser (the same rules and the same cases), not an
 * import: the app kit is published and reaches the platform only through its public packages. The
 * two must change together.
 *
 * shortcut: bigrams over-match short common pairs and need no dictionary; a morphological analyser
 * is the upgrade if precision matters more than a dependency-free install.
 */

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

/** Whether `term` is one CJK character, which a query matches as a prefix. */
function isLoneCjk(term: string): boolean {
  return [...term].length === 1 && CJK_RUN.test(term);
}

/** The terms of each whitespace-separated run of `query`, empty runs dropped. */
function queryRuns(query: string): string[][] {
  return query
    .split(/\s+/u)
    .map(searchTerms)
    .filter((terms) => terms.length > 0);
}

/**
 * Terms are letters and digits only, so quoting is for the grammar, not for safety. A lone CJK
 * character is a prefix (`'猫':*`) so it also finds the bigrams it starts, `猫で` in `黒猫です`.
 *
 * shortcut: a character that only ends a run (`猫` in `黒猫`) is still missed; indexing CJK
 * unigrams on the write side is the upgrade.
 */
function quoteTerm(term: string): string {
  return isLoneCjk(term) ? `'${term}':*` : `'${term}'`;
}

/**
 * A `to_tsquery('simple', …)` string: the terms of each run of the query joined by `<->` (so
 * `手順` inside `保守手順` must be adjacent bigrams), and the runs joined by `&`. `null` when the
 * query holds no term, which the caller answers as a bad query rather than as no result. The
 * output contains only terms and these operators, never user-typed tsquery syntax.
 */
export function searchQuery(query: string): string | null {
  const runs = queryRuns(query).map((terms) => terms.map(quoteTerm).join(' <-> '));
  return runs.length > 0 ? runs.join(' & ') : null;
}

function termMatches(wanted: string, term: string | undefined): boolean {
  if (term === undefined) return false;
  return isLoneCjk(wanted) ? term.startsWith(wanted) : term === wanted;
}

/** Whether `run` occurs in `terms` as adjacent terms, as `<->` asks. */
function hasRun(terms: readonly string[], run: readonly string[]): boolean {
  for (let start = 0; start + run.length <= terms.length; start += 1) {
    if (run.every((wanted, offset) => termMatches(wanted, terms[start + offset]))) return true;
  }
  return false;
}

/**
 * Whether the terms of a text match `query` as {@link searchQuery}'s tsquery would: every run
 * present as adjacent terms. The in-memory page store searches with it; `false` for a query with
 * no term.
 */
export function termsMatch(terms: readonly string[], query: string): boolean {
  const runs = queryRuns(query);
  return runs.length > 0 && runs.every((run) => hasRun(terms, run));
}
