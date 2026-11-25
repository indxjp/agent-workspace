// A small lexer for the story check: blanks comments and reads the titles of test calls.
const QUOTES = new Set(["'", '"', '`']);
// After one of these (or at the start), a `/` begins a regular expression, not a division.
const BEFORE_REGEX = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';']);
// A test, suite or step call, not a method such as `regex.test(...)`; `.each(...)` / `.for(...)` take the title in the call after theirs.
const TEST_CALL = /(?<![\w$.])(?:it|test|describe)((?:\s*\.\s*[A-Za-z]+)*)\s*\(/g;
const TABLE_MODIFIER = /\.\s*(?:each|for)\b/;

const isSpace = (c: string): boolean => c === ' ' || c === '\n' || c === '\t' || c === '\r';

/** One lexing pass over `text`; every method returns the index after what it consumed. */
class CommentBlanker {
  private readonly text: string;
  /** The pieces of the result: code as it is and each comment blanked, in order (#2394). */
  private readonly out: string[] = [];
  /** The index after the last piece in `out`. */
  private copied = 0;

  constructor(text: string) {
    this.text = text;
  }

  result(): string {
    this.code(0, false);
    this.out.push(this.text.slice(this.copied));
    return this.out.join('');
  }

  private blank(from: number, to: number): void {
    this.out.push(
      this.text.slice(this.copied, from),
      this.text.slice(from, to).replace(/[^\n]/g, ' '),
    );
    this.copied = to;
  }

  /** A string from its opening quote; a template's `${…}` is code. */
  private literal(start: number): number {
    const { text } = this;
    const quote = text[start];
    let k = start + 1;
    while (k < text.length) {
      const c = text[k];
      if (c === '\\') k += 2;
      else if (c === quote) return k + 1;
      else if (c === '\n' && quote !== '`') return k;
      else if (quote === '`' && c === '$' && text[k + 1] === '{') k = this.code(k + 2, true);
      else k += 1;
    }
    return k;
  }

  private regex(start: number): number {
    const { text } = this;
    let inClass = false;
    let k = start + 1;
    while (k < text.length) {
      const c = text[k];
      if (c === '\\') k += 2;
      else if (c === '\n') return k;
      else {
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) return k + 1;
        k += 1;
      }
    }
    return k;
  }

  /** Blanks the comment opening at `start` (`//` or `/*`) and returns the index after it. */
  private comment(start: number, isLine: boolean): number {
    const { text } = this;
    const close = isLine ? text.indexOf('\n', start) : text.indexOf('*/', start + 2);
    const end = close === -1 ? text.length : isLine ? close : close + 2;
    this.blank(start, end);
    return end;
  }

  /** Code from `start`; inside a template's `${`, it ends after the matching `}`. */
  private code(start: number, inTemplate: boolean): number {
    const { text } = this;
    let depth = 0;
    let previous = '';
    let k = start;
    while (k < text.length) {
      const c = text[k] ?? '';
      const next = text[k + 1];
      if (c === '/' && (next === '/' || next === '*')) {
        k = this.comment(k, next === '/');
      } else if (QUOTES.has(c)) {
        k = this.literal(k);
        previous = c;
      } else if (c === '/' && BEFORE_REGEX.has(previous)) {
        k = this.regex(k);
        previous = c;
      } else {
        if (c === '}' && inTemplate && depth === 0) return k + 1;
        if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        if (!isSpace(c)) previous = c;
        k += 1;
      }
    }
    return k;
  }
}

/**
 * `text` with every comment blanked (newlines kept) and its strings and regular expressions left
 * as they are, so a commented-out test earns no coverage. A lexer, not a parser: a regular
 * expression after a keyword reads as a division, which can misread the rest of its line.
 */
export function stripComments(text: string): string {
  return new CommentBlanker(text).result();
}

/** The string literal opening at `start` and the index after it, or `null`. */
function readLiteral(text: string, start: number): { value: string; end: number } | null {
  const quote = text[start] ?? '';
  if (!QUOTES.has(quote)) return null;
  for (let k = start + 1; k < text.length; k += 1) {
    if (text[k] === '\\') k += 1;
    else if (text[k] === quote) return { value: text.slice(start + 1, k), end: k + 1 };
  }
  return null;
}

/** The index of the `)` closing the `(` at `open`, or -1. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  let k = open;
  while (k < text.length) {
    const c = text[k] ?? '';
    if (QUOTES.has(c)) {
      k = readLiteral(text, k)?.end ?? text.length;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')' && --depth === 0) return k;
    k += 1;
  }
  return -1;
}

/** For `it.each(table)(title)`: the index after the second call's `(`, or `null` when absent. */
function afterTableCall(source: string, tableOpen: number): number | null {
  const close = closingParen(source, tableOpen);
  if (close === -1) return null;
  const nextCall = /\s*\(/y;
  nextCall.lastIndex = close + 1;
  const call = nextCall.exec(source);
  return call === null ? null : close + 1 + call[0].length;
}

/** The titles of the test, suite and step calls in `text`: their first string argument. */
export function testTitles(text: string): string[] {
  const source = stripComments(text);
  const titles: string[] = [];
  for (const m of source.matchAll(TEST_CALL)) {
    let at: number | null = (m.index ?? 0) + m[0].length;
    if (TABLE_MODIFIER.test(m[1] ?? '')) at = afterTableCall(source, at - 1);
    if (at === null) continue;
    while (isSpace(source[at] ?? '')) at += 1;
    const title = readLiteral(source, at);
    if (title !== null) titles.push(title.value);
  }
  return titles;
}
