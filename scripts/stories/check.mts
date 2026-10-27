#!/usr/bin/env node
// Storage story coverage (#1617, #1618): reads `[US-STO-xx][type][entry]` test-name tags and
// `// @story US-STO-xx` code tags from tracked files and prints the design §07 table.
// A gap prints and does not fail; a malformed tag exits 1. With `--base <ref>` (default
// `origin/main`, report-only when it is missing) a cell covered at the merge base and uncovered
// now also exits 1: no baseline file, the base tree is the baseline. Node stdlib and git only.
//
//   node scripts/stories/check.mts [--report | --base <ref>] [--json]
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export type Entry = 'web' | 'sdk' | 'cli' | 'run' | 'chat';
export type TestType = 'unit' | 'contract' | 'api' | 'browser' | 'load' | 'two-server';

/** Storage design §07 "User stories" matrix: the ● cells only (37). */
export const MATRIX: Readonly<Record<string, readonly Entry[]>> = {
  'US-STO-01': ['web', 'sdk', 'cli'],
  'US-STO-02': ['web', 'sdk', 'cli'],
  'US-STO-03': ['web', 'sdk', 'cli'],
  'US-STO-04': ['web', 'sdk', 'cli'],
  'US-STO-05': ['web', 'sdk', 'cli'],
  'US-STO-06': ['sdk', 'cli', 'run'],
  'US-STO-07': ['web', 'sdk', 'cli', 'run'],
  'US-STO-08': ['sdk', 'cli'],
  'US-STO-09': ['sdk', 'run', 'chat'],
  'US-STO-10': ['cli'],
  'US-STO-11': ['sdk', 'run', 'chat'],
  'US-STO-12': ['web', 'sdk', 'cli', 'run'],
  'US-STO-13': ['cli'],
  'US-STO-14': ['sdk'],
  // Builder design §07 (#1842). Accepted gaps until the issue in PROVING_ISSUES lands its tests.
  'US-BLD-01': ['web', 'sdk', 'run', 'chat'],
  'US-BLD-02': ['sdk', 'run', 'chat'],
  'US-BLD-03': ['web', 'sdk', 'cli', 'run'],
  'US-BLD-04': ['sdk', 'run'],
  'US-BLD-05': ['web', 'sdk', 'cli'],
  'US-BLD-06': ['sdk', 'cli'],
  'US-BLD-07': ['sdk', 'run'],
  'US-BLD-08': ['web', 'sdk'],
};

/** The issue that proves each Builder story; its gap prints with it until the tests exist. */
export const PROVING_ISSUES: Readonly<Record<string, string>> = {
  'US-BLD-01': '#1849',
  'US-BLD-02': '#1848',
  'US-BLD-03': '#1847',
  'US-BLD-04': '#1846',
  'US-BLD-05': '#1847',
  'US-BLD-06': '#1850',
  'US-BLD-07': '#1851',
  'US-BLD-08': '#1852',
};

/** Which test types cover a cell, first entry is the one a gap is reported against. */
export const ACCEPTS: Readonly<Record<Entry, readonly TestType[]>> = {
  web: ['browser'],
  sdk: ['api', 'two-server', 'load'],
  cli: ['api'],
  run: ['api', 'contract', 'load'],
  chat: ['api', 'browser'],
};

/** Cells stricter than ACCEPTS: two servers saving one path can only be proven by two servers. */
export const CELL_OVERRIDES: Readonly<Record<string, readonly TestType[]>> = {
  'US-STO-14:sdk': ['two-server'],
};

export interface Cell {
  story: string;
  entry: Entry;
  covered: boolean;
  /** The type that covered the cell, or the first accepted type for a gap. */
  type: TestType;
  by: string[];
}

export interface StoryError {
  file: string;
  tag: string;
  message: string;
}

export interface Report {
  cells: Cell[];
  errors: StoryError[];
  /** `// @story` locations by story ID. */
  codeTags: Record<string, string[]>;
}

const TEST_FILE = /\.(test\.(ts|tsx|mts)|spec\.mjs|e2e\.mjs)$/;
const PRODUCTION_FILE = /^(apps|packages)\/.*\.(ts|tsx|mjs)$/;
const TEST_TAG = /\[(US-(?:STO|BLD)-\d+)\]\[([^\]\s]+)\]\[([^\]\s]+)\]/g;
const CODE_TAG = /@story (US-(?:STO|BLD)-\d+)/g;
// What a story tag was meant to be: anything left of these once the well-formed tags are gone is malformed.
const TEST_TAG_CANDIDATE = /\[?\b(?:US-)?(?:STO|BLD)-[^\s'"`]*/gi;
const CODE_TAG_CANDIDATE = /@story\b[ \t]*\S*/gi;
// A test, suite or step call, not a method such as `regex.test(...)`; `.each(...)` / `.for(...)` take the title in the call after theirs.
const TEST_CALL = /(?<![\w$.])(?:it|test|describe)((?:\s*\.\s*[A-Za-z]+)*)\s*\(/g;
const QUOTES = new Set(["'", '"', '`']);
// After one of these (or at the start), a `/` begins a regular expression, not a division.
const BEFORE_REGEX = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';']);
// Its in-memory fixtures hold deliberately malformed and covering tags.
const SELF_TEST = 'tests/tooling/stories-check.test.ts';

const isEntry = (s: string): s is Entry => Object.hasOwn(ACCEPTS, s);
const TEST_TYPES: readonly string[] = ['unit', 'contract', 'api', 'browser', 'load', 'two-server'];
const isTestType = (s: string): s is TestType => TEST_TYPES.includes(s);

function accepted(story: string, entry: Entry): readonly TestType[] {
  return CELL_OVERRIDES[`${story}:${entry}`] ?? ACCEPTS[entry];
}

const isSpace = (c: string): boolean => c === ' ' || c === '\n' || c === '\t' || c === '\r';

/**
 * `text` with every comment blanked (newlines kept) and its strings and regular expressions left
 * as they are, so a commented-out test earns no coverage. A lexer, not a parser: a regular
 * expression after a keyword reads as a division, which can misread the rest of its line.
 */
export function stripComments(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  // A string from its opening quote; a template's `${…}` is code. Returns the index after it.
  function literal(start: number): number {
    const quote = text[start];
    let k = start + 1;
    while (k < text.length) {
      const c = text[k];
      if (c === '\\') k += 2;
      else if (c === quote) return k + 1;
      else if (c === '\n' && quote !== '`') return k;
      else if (quote === '`' && c === '$' && text[k + 1] === '{') k = code(k + 2, true);
      else k += 1;
    }
    return k;
  }
  function regex(start: number): number {
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
  // Code from `start`; inside a template's `${`, it ends after the matching `}`.
  function code(start: number, inTemplate: boolean): number {
    let depth = 0;
    let previous = '';
    let k = start;
    while (k < text.length) {
      const c = text[k] ?? '';
      const next = text[k + 1];
      if (c === '/' && (next === '/' || next === '*')) {
        const close = next === '/' ? text.indexOf('\n', k) : text.indexOf('*/', k + 2);
        const end = close === -1 ? text.length : next === '/' ? close : close + 2;
        blank(k, end);
        k = end;
        continue;
      }
      if (QUOTES.has(c)) {
        k = literal(k);
        previous = c;
        continue;
      }
      if (c === '/' && BEFORE_REGEX.has(previous)) {
        k = regex(k);
        previous = c;
        continue;
      }
      if (c === '{') depth += 1;
      else if (c === '}') {
        if (inTemplate && depth === 0) return k + 1;
        depth -= 1;
      }
      if (!isSpace(c)) previous = c;
      k += 1;
    }
    return k;
  }
  code(0, false);
  return out.join('');
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

/** The titles of the test, suite and step calls in `text`: their first string argument. */
export function testTitles(text: string): string[] {
  const source = stripComments(text);
  const titles: string[] = [];
  const nextCall = /\s*\(/y;
  for (const m of source.matchAll(TEST_CALL)) {
    let at = (m.index ?? 0) + m[0].length;
    if (/\.\s*(?:each|for)\b/.test(m[1] ?? '')) {
      const close = closingParen(source, at - 1);
      nextCall.lastIndex = close + 1;
      const call = close === -1 ? null : nextCall.exec(source);
      if (call === null) continue;
      at = close + 1 + call[0].length;
    }
    while (isSpace(source[at] ?? '')) at += 1;
    const title = readLiteral(source, at);
    if (title !== null) titles.push(title.value);
  }
  return titles;
}

/** Pure: path → source text in, report out. */
export function scan(files: ReadonlyMap<string, string>): Report {
  const errors: StoryError[] = [];
  const codeTags: Record<string, string[]> = {};
  const hits = new Map<string, Set<string>>();

  for (const [file, text] of files) {
    if (TEST_FILE.test(file)) {
      const titles = testTitles(text);
      for (const title of titles) {
        for (const m of title.replace(TEST_TAG, ' ').matchAll(TEST_TAG_CANDIDATE)) {
          errors.push({ file, tag: m[0], message: 'malformed story tag' });
        }
      }
      for (const m of titles.join('\n').matchAll(TEST_TAG)) {
        const [tag, story = '', type = '', entry = ''] = m;
        const cells = MATRIX[story];
        const problem = !cells
          ? `unknown story ${story}`
          : !isTestType(type)
            ? `unknown test type ${type}`
            : !isEntry(entry)
              ? `unknown entry ${entry}`
              : !cells.includes(entry)
                ? `${story} has no ${entry} cell in design §07`
                : undefined;
        if (problem) {
          errors.push({ file, tag, message: problem });
          continue;
        }
        const key = `${story}:${entry}:${type}`;
        hits.set(key, (hits.get(key) ?? new Set()).add(file));
      }
    } else if (PRODUCTION_FILE.test(file)) {
      for (const m of text.replace(CODE_TAG, ' ').matchAll(CODE_TAG_CANDIDATE)) {
        errors.push({ file, tag: m[0], message: 'malformed story tag' });
      }
      for (const m of text.matchAll(CODE_TAG)) {
        const [tag, story = ''] = m;
        if (!MATRIX[story]) {
          errors.push({ file, tag, message: `unknown story ${story}` });
          continue;
        }
        (codeTags[story] ??= []).push(file);
      }
    }
  }

  const cells: Cell[] = Object.entries(MATRIX).flatMap(([story, entries]) =>
    entries.map((entry): Cell => {
      const types = accepted(story, entry);
      const type = types.find((t) => hits.has(`${story}:${entry}:${t}`)) ?? types[0] ?? 'api';
      const by = [...(hits.get(`${story}:${entry}:${type}`) ?? [])];
      return { story, entry, covered: by.length > 0, type, by };
    }),
  );
  return { cells, errors, codeTags };
}

/** The §07 table: errors, one row per story, then the gap summary. */
export function render(report: Report): string {
  const lines = report.errors.map((e) => `error: ${e.file}: ${e.tag}: ${e.message}`);
  const gaps = report.cells.filter((c) => !c.covered);
  for (const story of Object.keys(MATRIX)) {
    const row = report.cells
      .filter((c) => c.story === story)
      .map((c) => `${c.entry}:${c.type} ${c.covered ? '✓' : '✗'}`);
    const proving = PROVING_ISSUES[story];
    const note = proving ? `  (Builder programme #1842, proven by ${proving})` : '';
    lines.push(`${story}  ${row.join('  ')}${note}`);
  }
  const stories = new Set(gaps.map((c) => c.story)).size;
  lines.push(
    `${stories} ${stories === 1 ? 'story' : 'stories'} with gaps · ${gaps.length} missing ${gaps.length === 1 ? 'test' : 'tests'}`,
  );
  return lines.join('\n');
}

/** Cells covered in `base` and uncovered in `head`, each with the files that covered it at the base. */
export function lostCells(base: Report, head: Report): Cell[] {
  const uncovered = new Set(
    head.cells.filter((c) => !c.covered).map((c) => `${c.story}:${c.entry}`),
  );
  return base.cells.filter((c) => c.covered && uncovered.has(`${c.story}:${c.entry}`));
}

const ROOTS = ['apps', 'packages', 'tests'];
const SCANNED = /\.(ts|tsx|mts|mjs)$/;
const isScanned = (file: string): boolean => SCANNED.test(file) && file !== SELF_TEST;
const git = (args: string[], input?: string): Buffer =>
  execFileSync('git', args, { input, maxBuffer: 512 * 1024 * 1024 });

/** Tracked files as they are on disk now, so an uncommitted deletion counts. */
export function readHead(): Map<string, string> {
  const tracked = git(['ls-files', '-z', '--', ...ROOTS])
    .toString('utf8')
    .split('\0');
  return new Map(
    tracked.filter((f) => isScanned(f) && existsSync(f)).map((f) => [f, readFileSync(f, 'utf8')]),
  );
}

/** The scanned files of `ref`: one `ls-tree`, then every blob through one `cat-file --batch`. */
export function readTree(ref: string): Map<string, string> {
  const blobs = git(['ls-tree', '-r', '-z', ref, '--', ...ROOTS])
    .toString('utf8')
    .split('\0')
    .flatMap((line) => {
      const m = /^\d+ blob ([0-9a-f]+)\t(.*)$/su.exec(line);
      return m?.[2] !== undefined && m[1] !== undefined && isScanned(m[2])
        ? [{ oid: m[1], file: m[2] }]
        : [];
    });
  const out = git(['cat-file', '--batch'], blobs.map((b) => `${b.oid}\n`).join(''));
  const files = new Map<string, string>();
  let pos = 0;
  for (const { oid, file } of blobs) {
    const eol = out.indexOf('\n', pos);
    const [id, kind, size] = out.toString('latin1', pos, eol).split(' ');
    if (id !== oid || kind !== 'blob') throw new Error(`git cat-file: no blob for ${file}`);
    const start = eol + 1;
    files.set(file, out.toString('utf8', start, start + Number(size)));
    pos = start + Number(size) + 1;
  }
  return files;
}

/** Each lost cell with the tag and the base files that covered it. */
export function renderLost(lost: readonly Cell[], base: string): string {
  return [
    ...lost.map(
      (c) => `lost: ${c.story} ${c.entry}:${c.type} covered at ${base} by ${c.by.join(', ')}`,
    ),
    `${lost.length} covered ${lost.length === 1 ? 'cell is' : 'cells are'} uncovered since ${base}`,
  ].join('\n');
}

const USAGE = 'usage: node scripts/stories/check.mts [--report | --base <ref>] [--json]';

function main(): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        report: { type: 'boolean' },
        base: { type: 'string' },
        json: { type: 'boolean' },
      },
      strict: true,
    }));
  } catch {
    console.error(USAGE);
    return 2;
  }
  if (values.report && values.base !== undefined) {
    console.error(USAGE);
    return 2;
  }

  let base = values.base;
  if (base === undefined && !values.report) {
    base = 'origin/main';
    try {
      git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
    } catch {
      console.error(`stories:check: ${base} not found, reporting only (fetch it to compare)`);
      base = undefined;
    }
  }

  const report = scan(readHead());
  console.log(values.json ? JSON.stringify(report) : render(report));
  let failed = report.errors.length > 0;
  if (base !== undefined) {
    const mergeBase = git(['merge-base', base, 'HEAD']).toString('utf8').trim();
    const lost = lostCells(scan(readTree(mergeBase)), report);
    if (lost.length > 0) {
      const text = renderLost(lost, mergeBase.slice(0, 12));
      if (values.json) console.error(text);
      else console.log(text);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
