import { describe, expect, it } from 'vitest';

import { inlineCode, mdxProse, mdxTableCell, typeCell } from '../../scripts/docs/lib/mdx.mjs';

describe('mdxProse', () => {
  it('escapes the characters MDX reads as syntax in prose', () => {
    expect(mdxProse('a < b and {c}')).toBe('a \\< b and \\{c\\}');
  });

  it('leaves a code span untouched, escaping only the prose around it', () => {
    expect(mdxProse('a `Map<string, T>` beside <b>')).toBe('a `Map<string, T>` beside \\<b\\>');
  });

  it('recognises a multi-backtick code span that contains backticks', () => {
    expect(mdxProse('see `` `${x}` `` and {y}')).toBe('see `` `${x}` `` and \\{y\\}');
  });
});

describe('inlineCode', () => {
  it('wraps plain text in single backticks', () => {
    expect(inlineCode('RunResource')).toBe('`RunResource`');
  });

  it('uses a fence one backtick longer than the longest run inside', () => {
    expect(inlineCode('`/api/agents/${id}`')).toBe('`` `/api/agents/${id}` ``');
    expect(inlineCode('a `` b')).toBe('```a `` b```');
  });

  it('pads a leading or trailing backtick with a space', () => {
    expect(inlineCode('`x')).toBe('`` `x ``');
    expect(inlineCode('x`')).toBe('`` x` ``');
  });
});

describe('mdxTableCell', () => {
  it('escapes a pipe so the cell does not end early', () => {
    expect(mdxTableCell('a | b')).toBe('a \\| b');
  });

  it('collapses newlines and surrounding whitespace into one space', () => {
    expect(mdxTableCell('first line\n   second line  \n third')).toBe(
      'first line second line third',
    );
  });

  it('escapes MDX syntax characters in the cell', () => {
    expect(mdxTableCell('{ code, message }')).toBe('\\{ code, message \\}');
  });
});

describe('typeCell', () => {
  it('backticks a type and escapes its pipes inside the span', () => {
    expect(typeCell('string | null')).toBe('`string \\| null`');
  });

  it('keeps a template literal inside a longer fence', () => {
    expect(typeCell('`${string}`')).toBe('`` `${string}` ``');
  });
});
