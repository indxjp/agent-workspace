/**
 * The Agent Store's screens never type a count in (spec §04 and "The store app"; P4): every number
 * a visitor reads about the catalog (agents, live, coming soon, areas, per area, per wave) comes
 * from `COUNTS`, and every handwritten line count and budget from `line-counts.generated.ts`.
 *
 * The check reads the store's screens (`examples/store/app/**`) as TypeScript and looks in what a
 * visitor can read, the JSX text and the string and template literals, for any of those numbers
 * standing alone. A numeric literal equal to one of them is refused too, unless it is too small to
 * be told apart from ordinary code (a radix, an index, a column count): those still fail when they
 * appear in text. The catalog itself and the generated files are the numbers' source, so they are
 * not read here.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { COUNTS } from '../../examples/store/catalog/index.ts';
import { LINE_COUNTS } from '../../examples/store/catalog/line-counts.generated.ts';
import { REPOSITORY_ROOT } from '../apps/registry.ts';

const APP_DIR = path.join(REPOSITORY_ROOT, 'examples', 'store', 'app');

/** The screens the spec names; the check is meaningless until each exists. */
const SCREENS = [
  'page.tsx',
  'agents/[slug]/page.tsx',
  'platform/page.tsx',
  'contact/page.tsx',
  'privacy/page.tsx',
  'sign-in/page.tsx',
] as const;

/** Numeric literals below this are ordinary code; in text every forbidden number counts. */
const SMALLEST_FORBIDDEN_LITERAL = 11;

/** Every number the catalog and the benchmark compute, as a visitor would read it. */
function computedNumbers(): ReadonlySet<number> {
  const numbers = [
    COUNTS.total,
    COUNTS.live,
    COUNTS.soon,
    COUNTS.areas,
    ...Object.values(COUNTS.byArea).flatMap(({ total, live }) => [total, live]),
    ...Object.values(COUNTS.byWave),
    ...Object.values(LINE_COUNTS).flatMap(({ handwritten, budget }) => [handwritten, budget]),
  ];
  // 0 and 1 are not counts a page could be caught typing: "0 runs" and "1 agent" are grammar.
  return new Set(numbers.filter((value) => value > 1));
}

/** A typed-in number: `where` in `file`, line `line`. */
interface Offence {
  readonly file: string;
  readonly line: number;
  readonly value: number;
  readonly where: 'text' | 'literal';
}

const STANDALONE_NUMBER = /(?<![\d.,])\d+(?![\d.,]*\d)/gu;

/** The forbidden numbers standing alone in `text`. */
function numbersIn(text: string, forbidden: ReadonlySet<number>): number[] {
  return [...text.matchAll(STANDALONE_NUMBER)]
    .map((match) => Number(match[0]))
    .filter((value) => forbidden.has(value));
}

/** The typed-in numbers of one screen file's source. */
function typedInNumbers(file: string, source: string, forbidden: ReadonlySet<number>): Offence[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offences: Offence[] = [];
  const at = (node: ts.Node): number =>
    parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxText(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      // An import specifier names a module, not text a visitor reads.
      if (!ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) {
        for (const value of numbersIn(node.text, forbidden)) {
          offences.push({ file, line: at(node), value, where: 'text' });
        }
      }
    } else if (ts.isNumericLiteral(node)) {
      const value = Number(node.text);
      if (value >= SMALLEST_FORBIDDEN_LITERAL && forbidden.has(value)) {
        offences.push({ file, line: at(node), value, where: 'literal' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return offences;
}

async function screenFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await screenFiles(full)));
    else if (/\.tsx?$/u.test(entry.name) && !entry.name.endsWith('.generated.ts')) found.push(full);
  }
  return found;
}

describe('the Agent Store screens type no count in', () => {
  const forbidden = computedNumbers();

  it('knows the numbers it looks for', () => {
    expect(forbidden.has(COUNTS.total)).toBe(true);
    expect(forbidden.has(COUNTS.live)).toBe(true);
    expect(forbidden.has(COUNTS.soon)).toBe(true);
    for (const { handwritten, budget } of Object.values(LINE_COUNTS)) {
      expect(forbidden.has(handwritten)).toBe(true);
      expect(forbidden.has(budget)).toBe(true);
    }
  });

  it('catches a count in JSX text, in a string, in a template and as a literal', () => {
    const total = String(COUNTS.total);
    const live = String(COUNTS.live);
    const source = [
      `export const a = <p>${total} agents</p>;`,
      `export const b = '${live}本が今すぐ試せる';`,
      `export const c = \`of \${n} — ${total} in all\`;`,
      `export const d = ${total};`,
    ].join('\n');
    expect(typedInNumbers('planted.tsx', source, forbidden).map(({ line }) => line)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('lets computed numbers, imports and other figures through', () => {
    const source = [
      `import { COUNTS } from '../catalog/index.ts';`,
      'export const a = <p>{COUNTS.total} agents</p>;',
      `export const b = '¥1,${String(COUNTS.total)},000';`,
      'export const c = parseInt(value, 10);',
    ].join('\n');
    expect(typedInNumbers('fine.tsx', source, forbidden)).toEqual([]);
  });

  it('every screen the spec names exists', () => {
    const missing = SCREENS.filter((screen) => !existsSync(path.join(APP_DIR, screen)));
    expect(missing, 'the store screens of spec "The store app"').toEqual([]);
  });

  it('no store screen or component types a count in', async () => {
    const offences: Offence[] = [];
    for (const file of await screenFiles(APP_DIR)) {
      const relative = path.relative(REPOSITORY_ROOT, file).split(path.sep).join('/');
      offences.push(...typedInNumbers(relative, await readFile(file, 'utf8'), forbidden));
    }
    expect(
      offences.map(
        ({ file, line, value, where }) => `${file}:${String(line)} ${where} ${String(value)}`,
      ),
      'read the number from COUNTS or LINE_COUNTS instead',
    ).toEqual([]);
  });
});
