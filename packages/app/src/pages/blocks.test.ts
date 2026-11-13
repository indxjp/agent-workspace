/**
 * The page block model: markdown in and out, and the refusal of a block type a page does not hold.
 * The round trip is a property over generated block trees; on a failure fast-check prints the seed
 * that reproduces it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { RichTextBlock } from '../fields/rich-text.js';
import { blocksPlainText, blocksToMarkdown, markdownToBlocks, pageBlockIssues } from './blocks.js';

/** Characters that include every piece of markdown syntax the converter reads. */
const CHARACTERS = [
  'a',
  'Z',
  '7',
  '手',
  '順',
  ' ',
  '#',
  '-',
  '*',
  '+',
  '>',
  '.',
  ')',
  '`',
  '\\',
  '_',
];

/** One line of text as a page stores it: not blank, no leading or trailing space. */
const line = fc
  .array(fc.constantFrom(...CHARACTERS), { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join('').trim())
  .filter((text) => text !== '');

const lines = (max: number) =>
  fc.array(line, { minLength: 1, maxLength: max }).map((parts) => parts.join('\n'));

/** Code keeps its lines exactly, blank and indented ones included. */
const codeText = fc
  .array(
    fc.array(fc.constantFrom(...CHARACTERS), { maxLength: 10 }).map((chars) => chars.join('')),
    { minLength: 1, maxLength: 4 },
  )
  .map((parts) => parts.join('\n'));

const listItem: fc.Memo<RichTextBlock> = fc.memo((depth) =>
  fc
    .record({
      type: fc.constantFrom('bulleted_item', 'numbered_item'),
      text: lines(2),
      children: depth <= 1 ? fc.constant([]) : fc.array(listItem(depth - 1), { maxLength: 3 }),
    })
    .map(({ type, text, children }) =>
      children.length === 0 ? { type, text } : { type, text, children },
    ),
);

const block: fc.Arbitrary<RichTextBlock> = fc.oneof(
  lines(3).map((text) => ({ type: 'paragraph', text })),
  fc.record({ type: fc.constantFrom('heading1', 'heading2', 'heading3'), text: line }),
  lines(3).map((text) => ({ type: 'quote', text })),
  codeText.map((text) => ({ type: 'code', text })),
  fc.constant({ type: 'divider' }),
  listItem(3),
);

describe('markdown and page blocks', () => {
  it('reads back every block tree it writes (property)', () => {
    fc.assert(
      fc.property(fc.array(block, { maxLength: 8 }), (blocks) => {
        const markdown = blocksToMarkdown(blocks);
        expect(markdownToBlocks(markdown)).toEqual(blocks);
        expect(pageBlockIssues(markdownToBlocks(markdown))).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it.each([
    ['', []],
    ['One.', [{ type: 'paragraph', text: 'One.' }]],
    [
      '## Two\n\nA line\nand another\n\n### Three',
      [
        { type: 'heading2', text: 'Two' },
        { type: 'paragraph', text: 'A line\nand another' },
        { type: 'heading3', text: 'Three' },
      ],
    ],
    [
      '- a\n  - b\n- c\n1. d\n2. e',
      [
        { type: 'bulleted_item', text: 'a', children: [{ type: 'bulleted_item', text: 'b' }] },
        { type: 'bulleted_item', text: 'c' },
        { type: 'numbered_item', text: 'd' },
        { type: 'numbered_item', text: 'e' },
      ],
    ],
    ['> said\n>\n> twice', [{ type: 'quote', text: 'said\n\ntwice' }]],
    ['```\nconst a = 1;\n\n```', [{ type: 'code', text: 'const a = 1;\n' }]],
    ['---', [{ type: 'divider' }]],
    ['\\# not a heading', [{ type: 'paragraph', text: '# not a heading' }]],
  ])('round-trips %j', (markdown, blocks) => {
    expect(markdownToBlocks(markdown)).toEqual(blocks);
    expect(blocksToMarkdown(blocks)).toBe(markdown);
  });

  it('reads the markdown an agent writes: CRLF, deeper headings, other markers and fences', () => {
    expect(
      markdownToBlocks('a\r\n \r\n#tag\n\n#### Four\n* x\n    + y\n\n```ts\nlet b;\n```'),
    ).toEqual([
      { type: 'paragraph', text: 'a' },
      { type: 'paragraph', text: '#tag' },
      { type: 'heading3', text: 'Four' },
      { type: 'bulleted_item', text: 'x', children: [{ type: 'bulleted_item', text: 'y' }] },
      { type: 'code', text: 'let b;' },
    ]);
  });

  it('keeps a block of another type on output: its text as a paragraph, its children after', () => {
    expect(
      blocksToMarkdown([
        { type: 'callout', text: '- Said', children: [{ type: 'paragraph', text: 'inner' }] },
        { type: 'heading6', text: 'Six' },
      ]),
    ).toBe('\\- Said\n\ninner\n\n### Six');
  });

  it('refuses a block type a page does not hold, and keys its type does not have', () => {
    expect(pageBlockIssues([{ type: 'paragraph', text: 'ok' }])).toEqual([]);
    expect(
      pageBlockIssues([
        { type: 'paragraph', text: 'ok' },
        { type: 'callout', text: 'x' },
      ]),
    ).toEqual(['blocks.1.type']);
    expect(pageBlockIssues([{ type: 'divider', text: 'x' }])).toEqual(['blocks.0.text']);
    expect(pageBlockIssues('nope')).toEqual(['blocks']);
  });

  it('extracts the plain text of every block, nested ones included', () => {
    expect(
      blocksPlainText([
        { type: 'heading1', text: '保守手順' },
        { type: 'divider' },
        {
          type: 'bulleted_item',
          text: 'Open',
          children: [{ type: 'bulleted_item', text: 'pump' }],
        },
      ]),
    ).toBe('保守手順\nOpen\npump');
  });
});
