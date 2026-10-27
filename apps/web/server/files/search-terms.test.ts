import { describe, expect, it } from 'vitest';

import {
  grantRoots,
  isGrantedPath,
  narrowFileGrants,
  searchTerms,
  snippetAround,
  toTsQuery,
} from './search-terms';

describe('searchTerms', () => {
  it('turns a Japanese run into overlapping bigrams', () => {
    expect(searchTerms('保守手順')).toEqual(['保守', '守手', '手順']);
  });

  it('keeps a single CJK character whole and long katakana intact via bigrams', () => {
    expect(searchTerms('猫')).toEqual(['猫']);
    expect(searchTerms('メンテナンス')).toEqual(['メン', 'ンテ', 'テナ', 'ナン', 'ンス']);
  });

  it('normalises full-width forms and case, and splits Latin from Japanese', () => {
    expect(searchTerms('ＡＢＣ点検２０２６ Pump-3')).toEqual(['abc', '点検', '2026', 'pump', '3']);
  });

  it('drops punctuation and operator characters', () => {
    expect(searchTerms("!&|:*()<>' ")).toEqual([]);
  });
});

describe('toTsQuery', () => {
  it('joins the bigrams of a run with <-> and runs with &', () => {
    expect(toTsQuery('手順')).toBe("'手順'");
    expect(toTsQuery('保守手順 pump')).toBe("'保守' <-> '守手' <-> '手順' & 'pump'");
  });

  it('makes a lone CJK character a prefix so it matches inside longer runs', () => {
    expect(toTsQuery('猫')).toBe("'猫':*");
    expect(toTsQuery('猫 a')).toBe("'猫':* & 'a'");
  });

  it('never passes tsquery syntax through', () => {
    expect(toTsQuery("a' | !b & (c:*)")).toBe("'a' & 'b' & 'c'");
    expect(toTsQuery("!&|:*()<>'")).toBeNull();
    expect(toTsQuery('   ')).toBeNull();
  });
});

describe('snippetAround', () => {
  it('shows the start when nothing matches literally, with an ellipsis if clipped', () => {
    const text = 'x'.repeat(400);
    expect(snippetAround(text, 'zzz')).toBe(`${'x'.repeat(160)}…`);
  });

  it('centres on the first occurrence of a query word', () => {
    const text = `${'a '.repeat(200)}needle ${'b '.repeat(200)}`;
    const snippet = snippetAround(text, 'needle');
    expect(snippet).toContain('needle');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('finds a half-width query in full-width text and centres on it', () => {
    const text = `${'あ'.repeat(200)}ＰＵＭＰ${'い'.repeat(200)}`;
    const snippet = snippetAround(text, 'pump');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.indexOf('PUMP')).toBe(41);
  });

  it('returns short text whole', () => {
    expect(snippetAround('保守手順\n書', '手順')).toBe('保守手順 書');
  });
});

describe('isGrantedPath', () => {
  it('matches an exact file or a folder prefix at a slash boundary only', () => {
    expect(isGrantedPath('a/b/c.pdf', ['a/b'])).toBe(true);
    expect(isGrantedPath('a/b', ['a/b'])).toBe(true);
    expect(isGrantedPath('a/bc/c.pdf', ['a/b'])).toBe(false);
    expect(isGrantedPath('x.pdf', [])).toBe(false);
  });
});

describe('grantRoots', () => {
  it('keeps a granted folder and drops what is inside it', () => {
    expect(
      grantRoots([
        { kind: 'directory', path: 'manuals' },
        { kind: 'file', path: 'manuals/a.pdf' },
        { kind: 'directory', path: 'manuals/old' },
        { kind: 'file', path: 'manualsX.pdf' },
        { kind: 'file', path: 'solo.pdf' },
      ]),
    ).toEqual(['manuals', 'manualsX.pdf', 'solo.pdf']);
  });
});

describe('narrowFileGrants (issue #1539)', () => {
  const entries = [
    { kind: 'directory', path: 'docs' },
    { kind: 'directory', path: 'docs/alice' },
    { kind: 'file', path: 'docs/alice/a.md' },
    { kind: 'directory', path: 'docs/bob' },
    { kind: 'file', path: 'docs/bob/b.md' },
    { kind: 'file', path: 'solo/one.pdf' },
  ] as const;
  const paths = (scope: readonly string[]): string[] =>
    narrowFileGrants(entries, scope).kept.map((entry) => entry.path);

  it('keeps a sub-folder of a folder grant with its contents', () => {
    const narrowed = narrowFileGrants(entries, ['docs/alice']);
    expect(narrowed.widens).toEqual([]);
    expect(narrowed.kept.map((entry) => entry.path)).toEqual(['docs/alice', 'docs/alice/a.md']);
  });

  it('keeps an exact file, and a scope equal to a grant keeps the whole grant', () => {
    expect(paths(['docs/bob/b.md'])).toEqual(['docs/bob/b.md']);
    expect(paths(['solo/one.pdf'])).toEqual(['solo/one.pdf']);
    const whole = narrowFileGrants(entries, ['docs']);
    expect(whole.widens).toEqual([]);
    expect(whole.kept).toHaveLength(5);
  });

  it('reports a parent of a file grant and an unrelated path as widening', () => {
    expect(narrowFileGrants(entries, ['solo']).widens).toEqual(['solo']);
    expect(narrowFileGrants(entries, ['other', 'docs/alice']).widens).toEqual(['other']);
  });

  it('matches nothing, and widens, for a non-canonical path', () => {
    const narrowed = narrowFileGrants(entries, ['docs/../solo/one.pdf']);
    expect(narrowed.kept).toEqual([]);
    expect(narrowed.widens).toEqual(['docs/../solo/one.pdf']);
  });

  it('narrows an empty scope to nothing', () => {
    expect(narrowFileGrants(entries, [])).toEqual({ kept: [], widens: [] });
  });
});
