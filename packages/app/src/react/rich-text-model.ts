/**
 * The block editor's edits (issue #1521), pure: each is a function `(blocks, op) => blocks` over a
 * page body, and every one leaves a body `pageBlockIssues` accepts. `RichText` draws a row per
 * top-level block and turns keys into these ops.
 *
 * The editor edits the top-level blocks. A list item's nested items stay with it, shown under its
 * row and moved with it; when the item stops being a list item they rise to follow it, so no text
 * is lost. shortcut: nested items are not edited in place; upgrade to indent and outdent ops when
 * the wiki needs nested lists written in the editor.
 */
import type { RichTextBlock } from '../fields/rich-text.js';
import { blocksPlainText, PAGE_BLOCK_TYPES, type PageBlockType } from '../pages/blocks.js';

/** One edit of a body. `index` is a top-level block's place; an op out of range changes nothing. */
export type RichTextOp =
  | { readonly type: 'setText'; readonly index: number; readonly text: string }
  | { readonly type: 'setType'; readonly index: number; readonly blockType: PageBlockType }
  /** Splits the block at `at` characters into it; the second half follows it. */
  | { readonly type: 'split'; readonly index: number; readonly at: number }
  /** Joins the block onto the one before it. */
  | { readonly type: 'merge'; readonly index: number }
  /** Moves the block one place up (`-1`) or down (`1`). */
  | { readonly type: 'move'; readonly index: number; readonly by: -1 | 1 }
  /** Adds an empty paragraph after the block (`-1`: at the start). */
  | { readonly type: 'insert'; readonly index: number }
  | { readonly type: 'remove'; readonly index: number };

const LIST_TYPES: ReadonlySet<string> = new Set(['bulleted_item', 'numbered_item']);
const KNOWN_TYPES: ReadonlySet<string> = new Set(PAGE_BLOCK_TYPES);

function isList(type: string): boolean {
  return LIST_TYPES.has(type);
}

/** A block of `type` with `text`, and `children` when it is a list item that has any. */
function blockOf(
  type: PageBlockType,
  text: string,
  children: readonly RichTextBlock[] = [],
): RichTextBlock {
  if (type === 'divider') return { type };
  if (isList(type) && children.length > 0) return { type, text, children };
  return { type, text };
}

/** The nested items of a block, made list items, so they may stand at the top. */
function listItemsOf(children: readonly RichTextBlock[]): RichTextBlock[] {
  return children.map((child) => {
    const type = isList(child.type) ? (child.type as PageBlockType) : 'bulleted_item';
    return blockOf(type, child.text ?? '', listItemsOf(child.children ?? []));
  });
}

/**
 * A body the editor can hold: every block of a page type with the keys its type has. A block of
 * another type (a body written by another resource) reads as a paragraph of its text.
 */
export function normalizeBlocks(blocks: readonly RichTextBlock[]): RichTextBlock[] {
  return blocks.map((block) => {
    if (!KNOWN_TYPES.has(block.type)) return blockOf('paragraph', blocksPlainText([block]));
    const type = block.type as PageBlockType;
    return blockOf(type, block.text ?? '', isList(type) ? listItemsOf(block.children ?? []) : []);
  });
}

/** The block at `index` as `type`: its text kept, its nested items risen after it when it is no list item. */
function retyped(block: RichTextBlock, type: PageBlockType): RichTextBlock[] {
  const text = block.text ?? '';
  const children = block.children ?? [];
  if (isList(type)) return [blockOf(type, text, children)];
  const risen = listItemsOf(children);
  // A divider holds no text, so the text it had goes on in a paragraph after it.
  if (type === 'divider') {
    return [{ type }, ...(text === '' ? [] : [blockOf('paragraph', text)]), ...risen];
  }
  return [blockOf(type, text), ...risen];
}

/** The type the second half of a split block takes: a heading continues as a paragraph. */
function continuationOf(type: string): PageBlockType {
  return type.startsWith('heading') || type === 'divider' ? 'paragraph' : (type as PageBlockType);
}

function split(block: RichTextBlock, at: number): RichTextBlock[] {
  const text = block.text ?? '';
  const cut = Math.max(0, Math.min(at, text.length));
  const type = block.type as PageBlockType;
  if (type === 'divider') return [block, blockOf('paragraph', '')];
  return [
    blockOf(type, text.slice(0, cut), block.children ?? []),
    blockOf(continuationOf(type), text.slice(cut)),
  ];
}

/** `block` joined onto `before`: one block of `before`'s type, or the divider among them dropped. */
function merged(before: RichTextBlock, block: RichTextBlock): RichTextBlock[] {
  if (before.type === 'divider') return [block];
  if (block.type === 'divider') return [before];
  const type = before.type as PageBlockType;
  const children = [...(before.children ?? []), ...(block.children ?? [])];
  const text = `${before.text ?? ''}${block.text ?? ''}`;
  if (isList(type)) return [blockOf(type, text, listItemsOf(children))];
  return [blockOf(type, text), ...listItemsOf(children)];
}

function replaced(
  blocks: readonly RichTextBlock[],
  start: number,
  count: number,
  replacement: readonly RichTextBlock[],
): RichTextBlock[] {
  return [...blocks.slice(0, start), ...replacement, ...blocks.slice(start + count)];
}

function moved(blocks: readonly RichTextBlock[], index: number, by: -1 | 1): RichTextBlock[] {
  const target = index + by;
  const block = blocks[index];
  const other = blocks[target];
  if (block === undefined || other === undefined) return [...blocks];
  const next = [...blocks];
  next[index] = other;
  next[target] = block;
  return next;
}

/** `blocks` after `op`. Pure: `blocks` is not changed. */
export function applyRichTextOp(blocks: readonly RichTextBlock[], op: RichTextOp): RichTextBlock[] {
  if (op.type === 'insert') {
    if (op.index < -1 || op.index >= blocks.length) return [...blocks];
    return replaced(blocks, op.index + 1, 0, [blockOf('paragraph', '')]);
  }
  const block = blocks[op.index];
  if (block === undefined) return [...blocks];
  switch (op.type) {
    case 'setText':
      return block.type === 'divider'
        ? [...blocks]
        : replaced(blocks, op.index, 1, [
            blockOf(block.type as PageBlockType, op.text, block.children ?? []),
          ]);
    case 'setType':
      return replaced(blocks, op.index, 1, retyped(block, op.blockType));
    case 'split':
      return replaced(blocks, op.index, 1, split(block, op.at));
    case 'merge': {
      const before = blocks[op.index - 1];
      return before === undefined
        ? [...blocks]
        : replaced(blocks, op.index - 1, 2, merged(before, block));
    }
    case 'move':
      return moved(blocks, op.index, op.by);
    case 'remove':
      return replaced(blocks, op.index, 1, listItemsOf(block.children ?? []));
  }
}

/** The body the editor shows: at least one block, so there is always a row to type in. */
export function editableBlocks(blocks: readonly RichTextBlock[]): RichTextBlock[] {
  const normal = normalizeBlocks(blocks);
  return normal.length === 0 ? [blockOf('paragraph', '')] : normal;
}
