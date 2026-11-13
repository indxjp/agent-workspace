import { describe, expect, it } from 'vitest';

import { storableJson, storableText } from './storable-text';

describe('storableText', () => {
  it('replaces NUL and lone surrogates and keeps well-formed pairs', () => {
    expect(storableText('a\u0000b')).toBe('a�b');
    expect(storableText('x\uD83D')).toBe('x�');
    expect(storableText('\uDE00y')).toBe('�y');
    expect(storableText('ok \u{1F600} あ')).toBe('ok \u{1F600} あ');
  });
});

describe('storableJson', () => {
  it('cleans strings and keys at any depth and leaves other values alone', () => {
    expect(storableJson({ 'k\u0000': [{ t: 'a\u0000', n: 1, b: null }, 'x\uD800'] })).toEqual({
      'k�': [{ t: 'a�', n: 1, b: null }, 'x�'],
    });
  });
});
