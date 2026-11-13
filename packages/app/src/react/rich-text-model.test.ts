/**
 * The block editor's ops (#1521): each case by example, and a property: any sequence of ops on
 * any page body yields a body the page block schema accepts. On a failure fast-check prints the
 * seed that reproduces it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { richText, type RichTextBlock } from '../fields/rich-text.js';
import { blocksPlainText, PAGE_BLOCK_TYPES, pageBlockIssues } from '../pages/blocks.js';
import {
  applyRichTextOp,
  editableBlocks,
  normalizeBlocks,
  type RichTextOp,
} from './rich-text-model.js';

const para = (text: string): RichTextBlock => ({ type: 'paragraph', text });
const item = (text: string, children?: RichTextBlock[]): RichTextBlock =>
  children === undefined
    ? { type: 'bulleted_item', text }
    : { type: 'bulleted_item', text, children };

describe('applyRichTextOp', () => {
  it('splits at the caret; a heading continues as a paragraph, a list item as an item', () => {
    expect(applyRichTextOp([para('hello world')], { type: 'split', index: 0, at: 5 })).toEqual([
      para('hello'),
      para(' world'),
    ]);
    expect(
      applyRichTextOp([{ type: 'heading1', text: 'Title' }], { type: 'split', index: 0, at: 5 }),
    ).toEqual([{ type: 'heading1', text: 'Title' }, para('')]);
    expect(
      applyRichTextOp([item('ab', [item('nested')])], { type: 'split', index: 0, at: 1 }),
    ).toEqual([item('a', [item('nested')]), item('b')]);
    expect(applyRichTextOp([{ type: 'divider' }], { type: 'split', index: 0, at: 0 })).toEqual([
      { type: 'divider' },
      para(''),
    ]);
  });

  it('merges onto the block before, keeping its type; a divider between is dropped', () => {
    expect(
      applyRichTextOp([{ type: 'quote', text: 'one ' }, para('two')], { type: 'merge', index: 1 }),
    ).toEqual([{ type: 'quote', text: 'one two' }]);
    expect(applyRichTextOp([{ type: 'divider' }, para('x')], { type: 'merge', index: 1 })).toEqual([
      para('x'),
    ]);
    expect(applyRichTextOp([para('x'), { type: 'divider' }], { type: 'merge', index: 1 })).toEqual([
      para('x'),
    ]);
    expect(applyRichTextOp([para('x')], { type: 'merge', index: 0 })).toEqual([para('x')]);
    expect(
      applyRichTextOp([para('a'), item('b', [item('c')])], { type: 'merge', index: 1 }),
    ).toEqual([para('ab'), item('c')]);
  });

  it('reorders by one place, and not past either end', () => {
    const blocks = [para('a'), para('b'), para('c')];
    expect(applyRichTextOp(blocks, { type: 'move', index: 0, by: 1 })).toEqual([
      para('b'),
      para('a'),
      para('c'),
    ]);
    expect(applyRichTextOp(blocks, { type: 'move', index: 0, by: -1 })).toEqual(blocks);
    expect(applyRichTextOp(blocks, { type: 'move', index: 2, by: 1 })).toEqual(blocks);
  });

  it('changes type keeping the text; nested items rise when the block is no list item', () => {
    expect(
      applyRichTextOp([para('Plan')], { type: 'setType', index: 0, blockType: 'heading2' }),
    ).toEqual([{ type: 'heading2', text: 'Plan' }]);
    expect(
      applyRichTextOp([item('a', [item('b')])], {
        type: 'setType',
        index: 0,
        blockType: 'numbered_item',
      }),
    ).toEqual([{ type: 'numbered_item', text: 'a', children: [item('b')] }]);
    expect(
      applyRichTextOp([item('a', [item('b')])], { type: 'setType', index: 0, blockType: 'code' }),
    ).toEqual([{ type: 'code', text: 'a' }, item('b')]);
    expect(
      applyRichTextOp([para('kept')], { type: 'setType', index: 0, blockType: 'divider' }),
    ).toEqual([{ type: 'divider' }, para('kept')]);
  });

  it('sets text, inserts and removes; an op out of range changes nothing', () => {
    expect(applyRichTextOp([para('a')], { type: 'setText', index: 0, text: 'b' })).toEqual([
      para('b'),
    ]);
    expect(
      applyRichTextOp([{ type: 'divider' }], { type: 'setText', index: 0, text: 'b' }),
    ).toEqual([{ type: 'divider' }]);
    expect(applyRichTextOp([para('a')], { type: 'insert', index: -1 })).toEqual([
      para(''),
      para('a'),
    ]);
    expect(applyRichTextOp([para('a'), para('b')], { type: 'remove', index: 0 })).toEqual([
      para('b'),
    ]);
    expect(applyRichTextOp([para('a')], { type: 'setText', index: 3, text: 'x' })).toEqual([
      para('a'),
    ]);
    expect(applyRichTextOp([para('a')], { type: 'insert', index: 4 })).toEqual([para('a')]);
  });

  it('does not change the blocks it is given', () => {
    const blocks = Object.freeze([para('a'), para('b')]);
    applyRichTextOp(blocks, { type: 'move', index: 0, by: 1 });
    expect(blocks).toEqual([para('a'), para('b')]);
  });
});

describe('normalizeBlocks and editableBlocks', () => {
  it('reads a block of another type as a paragraph of its text, and never shows no row', () => {
    expect(
      normalizeBlocks([{ type: 'callout', text: 'Note', children: [{ type: 'x', text: 'y' }] }]),
    ).toEqual([para('Note\ny')]);
    expect(normalizeBlocks([{ type: 'heading1', text: 'T' }, { type: 'divider' }])).toEqual([
      { type: 'heading1', text: 'T' },
      { type: 'divider' },
    ]);
    expect(editableBlocks([])).toEqual([para('')]);
  });
});

// ---------------------------------------------------------------------------------------------
// The property

const text = fc.string({ maxLength: 12 });
const listType = fc.constantFrom('bulleted_item', 'numbered_item');

const listItem: fc.Arbitrary<RichTextBlock> = fc.letrec<{ item: RichTextBlock }>((tie) => ({
  item: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.record({ type: listType, text }),
    fc.record({ type: listType, text, children: fc.array(tie('item'), { maxLength: 2 }) }),
  ),
})).item;

const block: fc.Arbitrary<RichTextBlock> = fc.oneof(
  fc.record({
    type: fc.constantFrom('paragraph', 'heading1', 'heading2', 'heading3', 'quote', 'code'),
    text,
  }),
  listItem,
  fc.constant({ type: 'divider' }),
);

const index = fc.integer({ min: -1, max: 6 });

const op: fc.Arbitrary<RichTextOp> = fc.oneof(
  fc.record({ type: fc.constant('setText' as const), index, text }),
  fc.record({
    type: fc.constant('setType' as const),
    index,
    blockType: fc.constantFrom(...PAGE_BLOCK_TYPES),
  }),
  fc.record({ type: fc.constant('split' as const), index, at: fc.integer({ min: -2, max: 14 }) }),
  fc.record({ type: fc.constant('merge' as const), index }),
  fc.record({
    type: fc.constant('move' as const),
    index,
    by: fc.constantFrom(-1 as const, 1 as const),
  }),
  fc.record({ type: fc.constant('insert' as const), index }),
  fc.record({ type: fc.constant('remove' as const), index }),
);

const fieldSchema = richText().zod;

describe('the property (#1521)', () => {
  it('any op sequence on any page body yields a body the block schema accepts', () => {
    fc.assert(
      fc.property(
        fc.array(block, { maxLength: 6 }),
        fc.array(op, { maxLength: 12 }),
        (start, ops) => {
          expect(pageBlockIssues(start)).toEqual([]);
          const end = ops.reduce(applyRichTextOp, start);
          expect(pageBlockIssues(end)).toEqual([]);
          expect(fieldSchema.safeParse(end).success).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('a split then a merge of the same block gives the text back', () => {
    fc.assert(
      fc.property(text, fc.integer({ min: 0, max: 12 }), (value, at) => {
        const start = [para(value)];
        const end = applyRichTextOp(applyRichTextOp(start, { type: 'split', index: 0, at }), {
          type: 'merge',
          index: 1,
        });
        expect(blocksPlainText(end)).toBe(value);
      }),
    );
  });
});
