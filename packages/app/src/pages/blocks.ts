/**
 * The page block model (issue #1520): the block types a page's `richText()` body holds, and the
 * one conversion between blocks and markdown, which the agent tools read and write. Pure.
 *
 * | Type                             | Markdown                         |
 * | -------------------------------- | -------------------------------- |
 * | `paragraph`                      | lines of text                    |
 * | `heading1`, `heading2`, `heading3` | `#`, `##`, `###` (`####`… read as `heading3`) |
 * | `bulleted_item`, `numbered_item` | `- text`, `1. text`; `children` are nested items |
 * | `quote`                          | `> ` lines                       |
 * | `code`                           | a backtick fence (its info string is not kept) |
 * | `divider`                        | `---`                            |
 *
 * {@link pageBlockIssues} refuses any other type on input, so a page stores only these. On
 * output a block of another type (a `richText()` value written before, or by another resource) is
 * kept: its text reads as a paragraph and its children follow it, so nothing is lost. A line of
 * text that would read as markdown syntax is escaped with a backslash, so
 * `markdownToBlocks(blocksToMarkdown(blocks))` gives the blocks back.
 */
import { z } from 'zod';

import type { RichTextBlock } from '../fields/rich-text.js';

/** The block types a page holds. */
export const PAGE_BLOCK_TYPES = [
  'paragraph',
  'heading1',
  'heading2',
  'heading3',
  'bulleted_item',
  'numbered_item',
  'quote',
  'code',
  'divider',
] as const;

/** A block type a page holds. */
export type PageBlockType = (typeof PAGE_BLOCK_TYPES)[number];

const TEXT_TYPES = ['paragraph', 'heading1', 'heading2', 'heading3', 'quote', 'code'] as const;
const LIST_TYPES = ['bulleted_item', 'numbered_item'] as const;

const TextBlockSchema = z.strictObject({ type: z.enum(TEXT_TYPES), text: z.string() });

interface ListItemBlock {
  readonly type: (typeof LIST_TYPES)[number];
  readonly text: string;
  readonly children?: readonly ListItemBlock[] | undefined;
}

const ListItemSchema: z.ZodType<ListItemBlock> = z.strictObject({
  type: z.enum(LIST_TYPES),
  text: z.string(),
  get children() {
    return z.array(ListItemSchema).optional();
  },
});

const DividerSchema = z.strictObject({ type: z.literal('divider') });

/** A page body: blocks of {@link PAGE_BLOCK_TYPES}, each with the keys its type has. */
const PageBlocksSchema = z.array(z.union([TextBlockSchema, ListItemSchema, DividerSchema]));

/**
 * The dotted paths at which `value` is not a page body (`blocks.2.type`), or none. The richText
 * field's own bounds (depth, size) are checked by the field.
 */
export function pageBlockIssues(value: unknown, prefix = 'blocks'): readonly string[] {
  const result = PageBlocksSchema.safeParse(value);
  if (result.success) return [];
  const paths = result.error.issues.flatMap((issue) => {
    // A union's failure names the block; the type is what decides which shape applies.
    const below = issue.path.map(String).join('.');
    const path = below === '' ? prefix : `${prefix}.${below}`;
    if (issue.code === 'unrecognized_keys') return issue.keys.map((key) => `${path}.${key}`);
    return issue.code === 'invalid_union' ? [`${path}.type`] : [path];
  });
  return [...new Set(paths)];
}

// ---------------------------------------------------------------------------------------------
// Blocks to markdown

const HEADING = /^heading([1-6])$/u;
/** A line that would read as markdown syntax, or starts with the escape itself. */
const SYNTAX_START =
  /^(?:#{1,6}(?:[ \t]|$)|[-*+][ \t]|\d{1,9}[.)][ \t]|>|`{3,}|(?:-{3,}|\*{3,}|_{3,})[ \t]*$|\\)/u;

function escapeLine(line: string): string {
  return SYNTAX_START.test(line) ? `\\${line}` : line;
}

function escapedLines(text: string): string[] {
  return text.split('\n').map(escapeLine);
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/gu) ?? []).map((run) => run.length));
}

function isListType(type: string): boolean {
  return type === 'bulleted_item' || type === 'numbered_item';
}

/** The lines of one list item and its children, `indent` spaces in, numbered `ordinal`. */
function listLines(block: RichTextBlock, indent: number, ordinal: number): string[] {
  const marker = block.type === 'numbered_item' ? `${String(ordinal)}.` : '-';
  const pad = ' '.repeat(indent);
  const inner = indent + marker.length + 1;
  const [first = '', ...rest] = escapedLines(block.text ?? '');
  return [
    `${pad}${marker} ${first}`,
    ...rest.map((line) => `${' '.repeat(inner)}${line}`),
    ...runLines(block.children ?? [], inner),
  ];
}

/** The lines of consecutive list items, each numbered within its run of numbered items. */
function runLines(blocks: readonly RichTextBlock[], indent: number): string[] {
  let ordinal = 0;
  return blocks.flatMap((block, index) => {
    ordinal =
      block.type === 'numbered_item' && blocks[index - 1]?.type === block.type ? ordinal + 1 : 1;
    if (isListType(block.type)) return listLines(block, indent, ordinal);
    // A block of another kind under an item continues the item's text, so it is not lost.
    const pad = ' '.repeat(indent);
    const text = blocksPlainText([block]);
    return text === '' ? [] : escapedLines(text).map((line) => `${pad}${line}`);
  });
}

/** The markdown of one block that is not a list item, children after it. */
function chunkOf(block: RichTextBlock): string[] {
  const text = block.text ?? '';
  const heading = HEADING.exec(block.type);
  const own = ((): string[] => {
    if (heading !== null) return [`${'#'.repeat(Math.min(Number(heading[1]), 3))} ${text}`];
    switch (block.type) {
      case 'divider':
        return ['---'];
      case 'quote':
        return [
          text
            .split('\n')
            .map((line) => (line === '' ? '>' : `> ${line}`))
            .join('\n'),
        ];
      case 'code': {
        const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
        return [`${fence}\n${text}\n${fence}`];
      }
      default:
        return text === '' ? [] : [escapedLines(text).join('\n')];
    }
  })();
  return [...own, ...chunksOf(block.children ?? [])];
}

/** One chunk per block, a run of list items as one chunk. */
function chunksOf(blocks: readonly RichTextBlock[]): string[] {
  const chunks: string[] = [];
  let run: RichTextBlock[] = [];
  const flush = (): void => {
    if (run.length > 0) chunks.push(runLines(run, 0).join('\n'));
    run = [];
  };
  for (const block of blocks) {
    if (isListType(block.type)) {
      run.push(block);
    } else {
      flush();
      chunks.push(...chunkOf(block));
    }
  }
  flush();
  return chunks;
}

/** The markdown of `blocks`: one chunk per block (a list's items together), blank-line separated. */
export function blocksToMarkdown(blocks: readonly RichTextBlock[]): string {
  return chunksOf(blocks).join('\n\n');
}

/** The text of `blocks` and everything under them, one block per line: what search indexes. */
export function blocksPlainText(blocks: readonly RichTextBlock[]): string {
  return blocks
    .flatMap((block) => [block.text ?? '', blocksPlainText(block.children ?? [])])
    .filter((text) => text !== '')
    .join('\n');
}

// ---------------------------------------------------------------------------------------------
// Markdown to blocks

const HEADING_LINE = /^(#{1,6})[ \t]+(.*)$/u;
const DIVIDER_LINE = /^(?:-{3,}|\*{3,}|_{3,})[ \t]*$/u;
const FENCE_OPEN = /^(`{3,})[^`]*$/u;
const QUOTE_LINE = /^>[ \t]?(.*)$/u;
const LIST_LINE = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/u;

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** A line of text with its escape removed. */
function unescapeLine(line: string): string {
  return line.startsWith('\\') && SYNTAX_START.test(line.slice(1)) ? line.slice(1) : line;
}

/** Whether `line` starts a block other than a paragraph. */
function startsBlock(line: string): boolean {
  return (
    HEADING_LINE.test(line) ||
    DIVIDER_LINE.test(line) ||
    FENCE_OPEN.test(line) ||
    QUOTE_LINE.test(line) ||
    LIST_LINE.test(line)
  );
}

/** A block read from `lines` at `start`, and the index of the line after it. */
interface Read {
  readonly blocks: RichTextBlock[];
  readonly next: number;
}

function readCode(lines: readonly string[], start: number, fence: string): Read {
  const close = new RegExp(`^\`{${String(fence.length)},}[ \\t]*$`, 'u');
  let end = start + 1;
  while (end < lines.length && !close.test(lines[end] ?? '')) end += 1;
  const text = lines.slice(start + 1, end).join('\n');
  return { blocks: [{ type: 'code', text }], next: Math.min(end + 1, lines.length) };
}

function readQuote(lines: readonly string[], start: number): Read {
  const texts: string[] = [];
  let next = start;
  for (let match = QUOTE_LINE.exec(lines[next] ?? ''); match !== null;) {
    texts.push(match[1] ?? '');
    next += 1;
    match = QUOTE_LINE.exec(lines[next] ?? '');
  }
  return { blocks: [{ type: 'quote', text: texts.join('\n') }], next };
}

function readParagraph(lines: readonly string[], start: number): Read {
  const texts: string[] = [];
  let next = start;
  while (next < lines.length) {
    const line = lines[next] ?? '';
    if (isBlank(line) || (next > start && startsBlock(line))) break;
    texts.push(unescapeLine(line.trim()));
    next += 1;
  }
  return { blocks: [{ type: 'paragraph', text: texts.join('\n') }], next };
}

interface OpenItem {
  readonly indent: number;
  readonly block: { type: string; text: string; children: RichTextBlock[] };
}

/** Drops the empty `children` arrays the list reader leaves. */
function withoutEmptyChildren(block: OpenItem['block']): RichTextBlock {
  return block.children.length === 0
    ? { type: block.type, text: block.text }
    : {
        type: block.type,
        text: block.text,
        children: block.children.map((child) => withoutEmptyChildren(child as OpenItem['block'])),
      };
}

/** One list line placed under the open item it is indented beneath. */
function placeItem(stack: OpenItem[], roots: OpenItem['block'][], match: RegExpExecArray): void {
  const indent = match[1]?.length ?? 0;
  while (stack.length > 0 && (stack.at(-1)?.indent ?? 0) >= indent) stack.pop();
  const marker = match[2] ?? '-';
  const block = {
    type: /^\d/u.test(marker) ? 'numbered_item' : 'bulleted_item',
    text: unescapeLine((match[3] ?? '').trimEnd()),
    children: [] as RichTextBlock[],
  };
  const parent = stack.at(-1);
  if (parent === undefined) roots.push(block);
  else parent.block.children.push(block);
  stack.push({ indent, block });
}

/** A list: items until a blank line or an unindented line that is not an item. */
function readList(lines: readonly string[], start: number): Read {
  const roots: OpenItem['block'][] = [];
  const stack: OpenItem[] = [];
  let next = start;
  while (next < lines.length) {
    const line = lines[next] ?? '';
    const match = LIST_LINE.exec(line);
    const open = stack.at(-1);
    if (match !== null) {
      placeItem(stack, roots, match);
    } else if (open !== undefined && !isBlank(line) && /^\s/u.test(line)) {
      open.block.text = `${open.block.text}\n${unescapeLine(line.trim())}`;
    } else {
      break;
    }
    next += 1;
  }
  return { blocks: roots.map(withoutEmptyChildren), next };
}

function readBlock(lines: readonly string[], start: number): Read {
  const line = lines[start] ?? '';
  const heading = HEADING_LINE.exec(line);
  if (heading !== null) {
    const level = Math.min((heading[1] ?? '#').length, 3);
    const text = (heading[2] ?? '').trim();
    return { blocks: [{ type: `heading${String(level)}`, text }], next: start + 1 };
  }
  if (DIVIDER_LINE.test(line)) return { blocks: [{ type: 'divider' }], next: start + 1 };
  const fence = FENCE_OPEN.exec(line);
  if (fence !== null) return readCode(lines, start, fence[1] ?? '```');
  if (QUOTE_LINE.test(line)) return readQuote(lines, start);
  if (LIST_LINE.test(line)) return readList(lines, start);
  return readParagraph(lines, start);
}

/**
 * The page blocks of `markdown` (CRLF read as LF): headings, dividers, fenced code, quotes,
 * bulleted and numbered lists (nested by indentation, a following indented line continuing an
 * item), and paragraphs of the lines between. A leading backslash before syntax is an escape.
 * Every block it makes is one {@link pageBlockIssues} accepts.
 */
export function markdownToBlocks(markdown: string): RichTextBlock[] {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: RichTextBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    if (isBlank(lines[index] ?? '')) {
      index += 1;
      continue;
    }
    const read = readBlock(lines, index);
    blocks.push(...read.blocks);
    index = read.next;
  }
  return blocks;
}
