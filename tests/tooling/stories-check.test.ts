// scripts/stories/check.mts (#1617, #1618): design §07 story × entry-point coverage report and base gate.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';

import { MATRIX, lostCells, render, scan, type Report } from '../../scripts/stories/check.mts';

const CHECK = path.resolve('scripts/stories/check.mts');
const TAG = '[US-STO-03][api][sdk]';
const tagged = (tag: string) => `it('${tag} x')`;
const scanFiles = (files: Record<string, string>): Report => scan(new Map(Object.entries(files)));
const lost = (base: Record<string, string>, head: Record<string, string>) =>
  lostCells(scanFiles(base), scanFiles(head)).map((c) => `${c.story} ${c.entry}`);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch repository with one commit per file set, oldest first; `null` deletes the file. */
function repoWith(...commits: Record<string, string | null>[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'stories-check-'));
  temps.push(dir);
  const git = (...args: string[]) =>
    spawnSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: dir, encoding: 'utf8' },
    );
  git('init', '-q');
  commits.forEach((files, i) => {
    for (const [file, text] of Object.entries(files)) {
      if (text === null) {
        git('rm', '-q', file);
        continue;
      }
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
      git('add', file);
    }
    git('commit', '-q', '-m', `c${i}`);
  });
  return dir;
}
const check = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [CHECK, ...args], { cwd, encoding: 'utf8' });

const scanTests = (...sources: string[]): Report =>
  scan(new Map(sources.map((text, i) => [`tests/f${i}.test.ts`, `it('${text} x')`])));
const cell = (report: Report, story: string, entry: string) =>
  report.cells.find((c) => c.story === story && c.entry === entry);

describe('stories:check', () => {
  it('a malformed tag fails and a missing cell is listed', () => {
    const report = scanTests('[US-STO-99][api][sdk]');
    expect(report.errors).not.toEqual([]);
    expect(render(report)).toContain('web:browser ✗');
  });

  it('the matrix has the 37 cells of design §07', () => {
    const storage = Object.entries(MATRIX).filter(([story]) => story.startsWith('US-STO-'));
    expect(storage.flatMap(([, entries]) => entries)).toHaveLength(37);
    expect(scanTests().cells.filter((c) => c.story.startsWith('US-STO-'))).toHaveLength(37);
  });

  it('a tag of an accepted type covers its cell', () => {
    const report = scanTests('[US-STO-03][api][sdk]');
    expect(cell(report, 'US-STO-03', 'sdk')).toMatchObject({
      covered: true,
      by: ['tests/f0.test.ts'],
    });
    expect(cell(report, 'US-STO-03', 'cli')?.covered).toBe(false);
    expect(report.errors).toEqual([]);
  });

  it('a known type that the cell does not accept covers nothing and is not an error', () => {
    const report = scanTests('[US-STO-01][unit][web]');
    expect(cell(report, 'US-STO-01', 'web')).toMatchObject({ covered: false, type: 'browser' });
    expect(report.errors).toEqual([]);
  });

  it('US-STO-14 needs the two-server test', () => {
    expect(cell(scanTests('[US-STO-14][api][sdk]'), 'US-STO-14', 'sdk')).toMatchObject({
      covered: false,
      type: 'two-server',
    });
    expect(cell(scanTests('[US-STO-14][two-server][sdk]'), 'US-STO-14', 'sdk')?.covered).toBe(true);
  });

  it.each([
    ['unknown story', '[US-STO-99][api][sdk]'],
    ['unknown test type', '[US-STO-01][smoke][sdk]'],
    ['unknown entry', '[US-STO-01][api][tui]'],
    ['a cell that is – in the matrix', '[US-STO-10][api][web]'],
    ['an uppercase test type', '[US-STO-01][Browser][web]'],
    ['a one-digit story', '[US-STO-1][api][sdk]'],
  ])('%s is an error and covers nothing', (_name, tag) => {
    const report = scanTests(tag);
    expect(report.errors).toMatchObject([{ file: 'tests/f0.test.ts', tag }]);
    expect(report.cells.every((c) => !c.covered)).toBe(true);
  });

  it.each([
    ['two segments', '[US-STO-02][api]'],
    ['an unclosed story', '[US-STO-01'],
    ['a bare story id', 'STO-01'],
    ['a malformed Builder tag', '[US-BLD-01][api]'],
    ['a lowercase tag', '[us-sto-01][api][sdk]'],
  ])('a malformed tag (%s) is an error and covers nothing', (_name, tag) => {
    const report = scanTests(tag);
    expect(report.errors).toMatchObject([
      { file: 'tests/f0.test.ts', tag, message: 'malformed story tag' },
    ]);
    expect(report.cells.every((c) => !c.covered)).toBe(true);
  });

  it.each([
    ['a line comment', `// it('${TAG} x')`],
    ['a block comment', `/*\n  it('${TAG} x');\n*/`],
    ['a stray string', `const note = '${TAG} x';`],
    ['an expectation', `expect(name).toBe('${TAG} x');`],
    ['a regular expression test call', `const ok = /x/.test('${TAG}');`],
  ])('a tag in %s covers nothing', (_name, source) => {
    const report = scan(new Map([['tests/a.test.ts', source]]));
    expect(cell(report, 'US-STO-03', 'sdk')?.covered).toBe(false);
    expect(report.errors).toEqual([]);
  });

  it.each([
    ['a title on the next line', `it(\n  '${TAG} x',\n  () => {},\n);`],
    ['an each table', `it.each([\n  ['a', 1],\n])(\n  '${TAG} %s',\n  () => {},\n);`],
    ['a template title', 'it(`' + TAG + ' ${name}`, () => {});'],
    ['a step', `test.step('${TAG} x', async () => {});`],
    ['a title after a regular expression', `const re = /'/;\nit('${TAG} x');`],
  ])('a tag in %s covers its cell', (_name, source) => {
    const report = scan(new Map([['tests/a.test.ts', source]]));
    expect(cell(report, 'US-STO-03', 'sdk')?.covered).toBe(true);
    expect(report.errors).toEqual([]);
  });

  it('a malformed @story code tag is an error', () => {
    const report = scan(new Map([['packages/x/src/a.ts', '// @story us-sto-03\nexport {};']]));
    expect(report.errors).toMatchObject([
      { file: 'packages/x/src/a.ts', tag: '@story us-sto-03', message: 'malformed story tag' },
    ]);
  });

  it('records a @story code tag and rejects an unknown one', () => {
    const report = scan(
      new Map([
        ['packages/x/src/a.ts', '// @story US-STO-03\nexport {};'],
        ['apps/web/b.tsx', '// @story US-STO-99'],
        ['apps/web/c.tsx', '// @story US-STO-123'],
      ]),
    );
    expect(report.codeTags).toEqual({ 'US-STO-03': ['packages/x/src/a.ts'] });
    expect(report.errors).toMatchObject([
      { file: 'apps/web/b.tsx', tag: '@story US-STO-99' },
      { file: 'apps/web/c.tsx', tag: '@story US-STO-123', message: 'unknown story US-STO-123' },
    ]);
  });

  it('reads @story only in production files and test tags only in test files', () => {
    const report = scan(
      new Map([
        ['packages/x/src/a.test.ts', '// @story US-STO-99'],
        ['packages/x/src/b.ts', "it('[US-STO-03][api][sdk] x')"],
        ['docs/c.ts', '// @story US-STO-99'],
      ]),
    );
    expect(report.errors).toEqual([]);
    expect(report.codeTags).toEqual({});
    expect(cell(report, 'US-STO-03', 'sdk')?.covered).toBe(false);
  });

  it('renders the summary line with singular and plural forms', () => {
    const all = (Object.entries(MATRIX) as [string, string[]][]).flatMap(([story, entries]) =>
      entries.map((entry) => {
        const type = entry === 'web' ? 'browser' : story === 'US-STO-14' ? 'two-server' : 'api';
        return `[${story}][${type}][${entry}]`;
      }),
    );
    expect(render(scanTests(...all))).toMatch(
      /^US-STO-01 {2}web:browser ✓ {2}sdk:api ✓ {2}cli:api ✓$/m,
    );
    expect(render(scanTests(...all))).toMatch(/0 stories with gaps · 0 missing tests$/);
    expect(render(scanTests(...all.filter((t) => t !== '[US-STO-13][api][cli]')))).toMatch(
      /1 story with gaps · 1 missing test$/,
    );
    expect(render(scanTests())).toMatch(/22 stories with gaps · 59 missing tests$/);
  });

  it('the repository has no malformed tag, and the scan is fast', () => {
    const started = Date.now();
    const run = spawnSync(process.execPath, ['scripts/stories/check.mts', '--json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ errors: [] });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('base comparison fails on an uncovered cell', () => {
    const dir = repoWith({ 'tests/a.test.ts': tagged(TAG) }, { 'tests/a.test.ts': null });
    const run = check(dir, '--base', 'HEAD~1');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('US-STO-03 sdk:api');
    expect(run.stdout).toContain('tests/a.test.ts');
  });

  it('base comparison passes on new coverage', () => {
    const dir = repoWith({ 'tests/x.test.ts': '' }, { 'tests/a.test.ts': tagged(TAG) });
    expect(check(dir, '--base', 'HEAD~1').status).toBe(0);
  });

  it('base comparison passes on a renamed tagged test', () => {
    const dir = repoWith(
      { 'tests/a.test.ts': tagged(TAG) },
      { 'tests/a.test.ts': null, 'tests/b.test.ts': tagged(TAG) },
    );
    expect(check(dir, '--base', 'HEAD~1').status).toBe(0);
  });

  it('--report never fails on a lost cell, and an unknown flag exits 2', () => {
    const dir = repoWith({ 'tests/a.test.ts': tagged(TAG) }, { 'tests/a.test.ts': null });
    expect(check(dir, '--report').status).toBe(0);
    expect(check(dir, '--bogus').status).toBe(2);
  });

  it('--require-complete fails on one gap', () => {
    // Every storage cell but one: US-STO-13 cli has no test.
    const covering = Object.entries(MATRIX)
      .filter(([story]) => story.startsWith('US-STO-') && story !== 'US-STO-13')
      .flatMap(([story, entries]) =>
        entries.map((entry) => {
          const type = entry === 'web' ? 'browser' : story === 'US-STO-14' ? 'two-server' : 'api';
          return tagged(`[${story}][${type}][${entry}]`);
        }),
      );
    const gap = repoWith({ 'tests/a.test.ts': covering.join('\n') });
    const failed = check(gap, '--report', '--require-complete');
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain('incomplete: US-STO-13 cli:api');
    expect(failed.stdout).not.toContain('incomplete: US-BLD-');

    const whole = repoWith({
      'tests/a.test.ts': [...covering, tagged('[US-STO-13][api][cli]')].join('\n'),
    });
    expect(check(whole, '--report', '--require-complete').status).toBe(0);
  });

  it('the repository has no storage gap', () => {
    expect(check(process.cwd(), '--report', '--require-complete').status).toBe(0);
  });

  it('comparing the repository with itself passes in under 10 s', () => {
    const started = Date.now();
    expect(check(process.cwd(), '--base', 'HEAD').status).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('lostCells: a removed test fails', () => {
    expect(lost({ 'tests/a.test.ts': tagged(TAG) }, {})).toEqual(['US-STO-03 sdk']);
  });

  it('lostCells: a test that was commented out fails', () => {
    expect(
      lost({ 'tests/a.test.ts': tagged(TAG) }, { 'tests/a.test.ts': `// ${tagged(TAG)}` }),
    ).toEqual(['US-STO-03 sdk']);
  });

  it('lostCells: unchanged and new coverage pass', () => {
    const files = { 'tests/a.test.ts': tagged(TAG) };
    expect(lost(files, files)).toEqual([]);
    expect(lost({}, files)).toEqual([]);
  });

  it('lostCells: a renamed test that keeps its tag passes', () => {
    expect(
      lost({ 'tests/a.test.ts': tagged(TAG) }, { 'tests/moved/b.test.ts': `it('${TAG} renamed')` }),
    ).toEqual([]);
  });
});
