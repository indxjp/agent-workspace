import { describe, expect, it } from 'vitest';

import { revealInvisible, stripControlSequences } from './index.js';

describe('revealInvisible', () => {
  it.each([
    ['a zero-width space', '​', '<U+200B>'],
    ['a zero-width joiner', '‍', '<U+200D>'],
    ['a right-to-left override', '‮', '<U+202E>'],
    ['a bidirectional isolate', '⁦', '<U+2066>'],
    ['a word joiner', '⁠', '<U+2060>'],
    ['a soft hyphen', '­', '<U+00AD>'],
    ['a byte order mark', '﻿', '<U+FEFF>'],
    ['a tag character', '\u{E0041}', '<U+E0041>'],
    ['a variation selector from the supplement', '\u{E0100}', '<U+E0100>'],
    ['a Hangul filler', 'ㅤ', '<U+3164>'],
    ['a line separator', ' ', '<U+2028>'],
    ['a combining grapheme joiner', '͏', '<U+034F>'],
    ['DEL', '\x7F', '<U+007F>'],
    ['a C1 control', '\x9B', '<U+009B>'],
    ['NUL', '\x00', '<U+0000>'],
    ['ESC', '\x1B', '<U+001B>'],
    ['a carriage return', '\r', '<U+000D>'],
    ['a no-break space', '\u00A0', '<U+00A0>'],
    ['an en space', '\u2002', '<U+2002>'],
    ['a hair space', '\u200A', '<U+200A>'],
    ['a narrow no-break space', '\u202F', '<U+202F>'],
    ['a medium mathematical space', '\u205F', '<U+205F>'],
    ['an ideographic space', '\u3000', '<U+3000>'],
    ['variation selector 16', '\uFE0F', '<U+FE0F>'],
    ['variation selector 1', '\uFE00', '<U+FE00>'],
    ['a Mongolian free variation selector', '\u180B', '<U+180B>'],
    ['a braille blank', '\u2800', '<U+2800>'],
  ])('writes %s as its code point', (_name, hidden, shown) => {
    expect(revealInvisible(`a${hidden}b`)).toBe(`a${shown}b`);
  });

  it('keeps visible text, an ASCII space, tab, newline and CJK text as it is', () => {
    const text = 'Refund 12 EUR\t日本語\n「確認」 ほか';
    expect(revealInvisible(text)).toBe(text);
  });

  it('makes two strings that differ only by a hidden character differ', () => {
    const rule = 'Never approve a refund over 100 EUR.';
    const hidden = 'Never approve a refund​ over 100 EUR.';
    expect(revealInvisible(rule)).not.toBe(revealInvisible(hidden));
    expect(revealInvisible(hidden)).toBe('Never approve a refund<U+200B> over 100 EUR.');
  });

  it('shows a rule written with a no-break space differently from the ASCII one', () => {
    expect(revealInvisible('Bash(git status)')).not.toBe(revealInvisible('Bash(git\u00A0status)'));
  });

  it('never deletes a control sequence: an unterminated escape and its payload stay visible', () => {
    expect(revealInvisible('ok\x1b]0;never ended')).toBe('ok<U+001B>]0;never ended');
    expect(revealInvisible('a\x1b[2Jb\x9b31m')).toBe('a<U+001B>[2Jb<U+009B>31m');
  });
});

describe('stripControlSequences', () => {
  it('drops escape sequences with their payload, and every other control but tab and newline', () => {
    const hostile =
      'safe\x1b[2Jtext\x1b]0;pwned\x07 and \x1b]8;;http://evil\x1b\\link\x1b]8;;\x1b\\ \x1bZ\x9b31m end\x00\x7f\r!';
    expect(stripControlSequences(hostile)).toBe('safetext and link 31m end!');
    expect(stripControlSequences('a\tb\nc')).toBe('a\tb\nc');
  });

  it('drops an unterminated sequence to the end of the text', () => {
    expect(stripControlSequences('ok\x1b]0;never ended')).toBe('ok');
    expect(stripControlSequences('ok\x1b[12')).toBe('ok');
    expect(stripControlSequences('ok\x1b')).toBe('ok');
  });

  it('leaves invisible format characters to revealInvisible', () => {
    expect(stripControlSequences('a​b')).toBe('a​b');
  });
});
