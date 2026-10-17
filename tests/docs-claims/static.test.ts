import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SETUP_QUESTIONS } from '@indx-workspace/contracts/setup';
import { describe, expect, it } from 'vitest';

import { extractClaims } from './extract.mjs';
import {
  galleryProblems,
  INSTALL_COMMANDS,
  installProblems,
  stackFlagProblems,
  staticProblems,
} from './static.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANUAL_AGENT = 'tests/gallery/manual-search/agents/manual-search.ts';
const MANUAL_PAGE = 'docs/sdk/site/tutorials/manual-search.mdx';
const QUESTION_FLAGS = SETUP_QUESTIONS.map((question) => question.flag);

const text = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');

describe('a doc copy of a gallery file', () => {
  const claims = extractClaims(MANUAL_PAGE, text(MANUAL_PAGE));
  const exact = claims.filter((claim) => claim.file === MANUAL_AGENT);

  it('has a claim that holds the whole agent', () => {
    expect(exact).toHaveLength(1);
    expect(galleryProblems(exact, (file) => text(file))).toEqual([]);
  });

  it('fails when one line of the file changes and the page does not', () => {
    const edited = text(MANUAL_AGENT).replace(/^(.*name: '.*)$/mu, '$1 // edited');
    expect(edited).not.toBe(text(MANUAL_AGENT));
    const problems = galleryProblems(exact, (file) => (file === MANUAL_AGENT ? edited : undefined));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${MANUAL_PAGE}:`);
    expect(problems[0]).toContain('update the page');
  });

  it('fails when the file is gone', () => {
    expect(galleryProblems(exact, () => undefined)[0]).toContain('does not exist');
  });

  it('checks an excerpt line by line, in order, and lets a line elide with …', () => {
    const claim = (body: string) => ({
      page: 'p.mdx',
      line: 3,
      state: 'file' as const,
      lang: 'ts',
      body,
      title: '',
      file: 'f.ts#excerpt',
    });
    const read = (): string => 'one\ntwo = 2;\nthree\n';
    expect(galleryProblems([claim('one\nthree')], read)).toEqual([]);
    expect(galleryProblems([claim('two = …;')], read)).toEqual([]);
    expect(galleryProblems([claim('three\none')], read)[0]).toContain('no longer has "one"');
  });
});

describe('the landing page stack builder', () => {
  const siteJs = text('sites/lp/assets/site.js');

  it('only writes flags a setup question has', () => {
    expect(QUESTION_FLAGS.length).toBeGreaterThan(0);
    expect(stackFlagProblems(siteJs, QUESTION_FLAGS)).toEqual([]);
  });

  it('fails when a question flag is renamed and site.js is not', () => {
    const renamed = QUESTION_FLAGS.map((flag) => (flag === 'engine' ? 'runtime' : flag));
    const problems = stackFlagProblems(siteJs, renamed);
    expect(problems).toEqual([
      'sites/lp/assets/site.js: the stack builder writes --engine, which no setup question has (SETUP_QUESTIONS)',
    ]);
  });

  it('fails when it has no flag table to check', () => {
    expect(stackFlagProblems('var x = 1;', QUESTION_FLAGS)[0]).toContain('no CREATE_FLAGS');
  });
});

describe('the install block', () => {
  const block = (page: string, commands: readonly string[]) =>
    extractClaims(page, ['```sh claim="run"', ...commands.map((c) => `$ ${c}`), '```'].join('\n'));
  const everywhere = (commands: readonly string[]) =>
    ['README.md', 'docs/sdk/site/getting-started/quickstart.mdx'].flatMap((page) =>
      block(page, commands),
    );

  it('is the non-interactive one', () => {
    expect(INSTALL_COMMANDS[0]).toBe('npm create @indx-workspace@latest my-agent -- --yes');
  });

  it('fails on a page whose block differs from the others', () => {
    const lp = [
      '<pre data-claim="run"><span class="p">$ </span>',
      `${INSTALL_COMMANDS[0] ?? ''}\n<span class="p">$ </span>cd my-agent\n`,
      '<span class="p">$ </span>npm install\n',
      '<span class="p">$ </span>npm run dev</pre>',
    ].join('');
    const claims = [...everywhere(INSTALL_COMMANDS), ...extractClaims('sites/lp/index.html', lp)];
    const problems = installProblems(claims);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('sites/lp/index.html:1: the install block runs');
  });

  it('fails when a page shows no install block', () => {
    const problems = installProblems(everywhere(INSTALL_COMMANDS));
    expect(problems).toEqual([
      `sites/lp/index.html: shows no run install block (${INSTALL_COMMANDS.join(', ')})`,
    ]);
  });
});

describe('this checkout', () => {
  it('has no stale gallery copy, stack flag or install block', () => {
    expect(staticProblems(ROOT, QUESTION_FLAGS)).toEqual([]);
  });
});
