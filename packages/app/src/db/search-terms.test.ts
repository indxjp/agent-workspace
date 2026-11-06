import { describe, expect, it } from 'vitest';

import { searchQuery, searchTerms, termsMatch } from './search-terms.js';

// The cases of the platform's file-search tokeniser, which this module ports.
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

describe('searchQuery', () => {
  it('joins the bigrams of a run with <-> and runs with &', () => {
    expect(searchQuery('手順')).toBe("'手順'");
    expect(searchQuery('保守手順 pump')).toBe("'保守' <-> '守手' <-> '手順' & 'pump'");
  });

  it('makes a lone CJK character a prefix so it matches inside longer runs', () => {
    expect(searchQuery('猫')).toBe("'猫':*");
    expect(searchQuery('猫 a')).toBe("'猫':* & 'a'");
  });

  it('never passes tsquery syntax through', () => {
    expect(searchQuery("a' | !b & (c:*)")).toBe("'a' & 'b' & 'c'");
    expect(searchQuery("!&|:*()<>'")).toBeNull();
    expect(searchQuery('   ')).toBeNull();
  });
});

describe('termsMatch', () => {
  const terms = searchTerms('保守手順 for the Pump. 黒猫です');

  it('finds a word inside a Japanese run, and a Latin word in any case', () => {
    expect(termsMatch(terms, '手順')).toBe(true);
    expect(termsMatch(terms, 'PUMP 保守')).toBe(true);
  });

  it('needs every run, adjacent, and a lone character as a prefix', () => {
    expect(termsMatch(terms, '手順 valve')).toBe(false);
    expect(termsMatch(terms, '保手')).toBe(false);
    expect(termsMatch(terms, '猫')).toBe(true);
    expect(termsMatch(terms, '!!')).toBe(false);
  });
});
