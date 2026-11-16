'use client';
/**
 * `RichText`: a page body's block editor (issue #1521), without an editor dependency. Each block
 * is a row: a type select (paragraph, heading 1-3, bulleted or numbered item, quote, code,
 * divider) and a labelled `<textarea>`. Enter at the end of a block splits it, Backspace at its
 * start joins it to the one before, and Alt+Up / Alt+Down move it; Shift+Enter, a code block and
 * a Japanese input method's Enter keep their own meaning.
 *
 * The edits are `rich-text-model.ts`'s pure ops, so the body it hands `onChange` always passes the
 * page block schema. `readOnly` renders the body as markdown through `AssistantProse`, which draws
 * no raw HTML (ADR-0141). The editor never makes an element editable in place and never injects
 * raw HTML.
 */
import { AssistantProse } from '@indx-workspace/react';
import { useEffect, useId, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';

import type { RichTextBlock } from '../fields/rich-text.js';
import { blocksToMarkdown, PAGE_BLOCK_TYPES, type PageBlockType } from '../pages/blocks.js';
import { useAppLocale } from './locale-context.js';
import { appStrings, type AppLocale, type PageStrings } from './locale.js';
import { applyRichTextOp, editableBlocks, type RichTextOp } from './rich-text-model.js';

/** The props of {@link RichText}. */
export interface RichTextProps {
  readonly value: readonly RichTextBlock[];
  /** Given the whole body after each edit; not called when `readOnly`. */
  readonly onChange?: ((blocks: RichTextBlock[]) => void) | undefined;
  /** Draws the body as prose rather than as an editor. */
  readonly readOnly?: boolean | undefined;
  /** The accessible name of the body; the page body's own when not given. */
  readonly label?: string | undefined;
  /** The language of the editor's words; the `AppTheme`'s when not given, `en` outside one. */
  readonly locale?: AppLocale | undefined;
}

/** Where the focus goes after an edit: a row, and the caret in its text. */
interface Caret {
  readonly index: number;
  readonly at: number;
}

/** The op a key on a block's text box asks for, and where the caret goes after it; or none. */
function keyOp(
  event: KeyboardEvent<HTMLTextAreaElement>,
  index: number,
  block: RichTextBlock,
  blocks: readonly RichTextBlock[],
): { readonly op: RichTextOp; readonly caret: Caret } | null {
  const box = event.currentTarget;
  const collapsed = box.selectionStart === box.selectionEnd;
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    const by = event.key === 'ArrowUp' ? -1 : 1;
    return {
      op: { type: 'move', index, by },
      caret: { index: index + by, at: box.selectionStart },
    };
  }
  if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return null;
  const text = block.text ?? '';
  if (
    event.key === 'Enter' &&
    !event.shiftKey &&
    block.type !== 'code' &&
    collapsed &&
    box.selectionStart === text.length
  ) {
    return { op: { type: 'split', index, at: text.length }, caret: { index: index + 1, at: 0 } };
  }
  if (event.key === 'Backspace' && collapsed && box.selectionStart === 0 && index > 0) {
    const before = blocks[index - 1];
    const at = before?.type === 'divider' ? 0 : (before?.text ?? '').length;
    return { op: { type: 'merge', index }, caret: { index: index - 1, at } };
  }
  return null;
}

/** One block's row: its type select, its text box (none for a divider), and its remove button. */
function BlockRow({
  id,
  index,
  block,
  strings,
  onOp,
  onKey,
  textRef,
}: {
  readonly id: string;
  readonly index: number;
  readonly block: RichTextBlock;
  readonly strings: PageStrings;
  readonly onOp: (op: RichTextOp, caret?: Caret) => void;
  readonly onKey: (event: KeyboardEvent<HTMLTextAreaElement>, index: number) => void;
  readonly textRef: (element: HTMLTextAreaElement | HTMLSelectElement | null) => void;
}): ReactNode {
  const place = index + 1;
  const type = block.type as PageBlockType;
  const typeName = strings.blockTypes[type];
  const nested = block.children?.length ?? 0;
  const text = block.text ?? '';
  return (
    <li className="aw-app-rich-text-block" data-type={type}>
      <select
        id={`${id}-type`}
        aria-label={strings.blockTypeLabel(place)}
        value={type}
        ref={type === 'divider' ? textRef : undefined}
        onChange={(event) =>
          onOp(
            { type: 'setType', index, blockType: event.target.value as PageBlockType },
            { index, at: text.length },
          )
        }
        onKeyDown={(event) => {
          if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault();
            const by = event.key === 'ArrowUp' ? -1 : 1;
            onOp({ type: 'move', index, by }, { index: index + by, at: 0 });
          }
        }}
      >
        {PAGE_BLOCK_TYPES.map((option) => (
          <option key={option} value={option}>
            {strings.blockTypes[option]}
          </option>
        ))}
      </select>
      {type === 'divider' ? (
        <hr className="aw-app-rich-text-divider" />
      ) : (
        <>
          <label htmlFor={`${id}-text`} className="aw-app-sr-only">
            {strings.blockTextLabel(place, typeName)}
          </label>
          <textarea
            id={`${id}-text`}
            ref={textRef}
            className="aw-app-rich-text-input"
            value={text}
            rows={Math.max(1, text.split('\n').length)}
            spellCheck={type !== 'code'}
            onChange={(event) => onOp({ type: 'setText', index, text: event.target.value })}
            onKeyDown={(event) => onKey(event, index)}
          />
        </>
      )}
      {nested === 0 ? null : <p className="aw-app-hint">{strings.nestedItems(nested)}</p>}
      <button
        type="button"
        className="aw-app-button aw-app-rich-text-remove"
        aria-label={strings.removeBlock(place)}
        onClick={() => onOp({ type: 'remove', index }, { index: Math.max(0, index - 1), at: 0 })}
      >
        ×
      </button>
    </li>
  );
}

/** A page body: an editor of blocks, or with `readOnly` the body drawn as prose. */
export function RichText(props: RichTextProps): ReactNode {
  const { value, onChange, readOnly } = props;
  const strings = appStrings(useAppLocale(props.locale)).pages;
  const id = useId();
  const blocks = useMemo(() => editableBlocks(value), [value]);
  const boxes = useRef<(HTMLTextAreaElement | HTMLSelectElement | null)[]>([]);
  const caret = useRef<Caret | null>(null);

  // After an edit that moves the focus, put it on its row with the caret where the edit left it.
  useEffect(() => {
    const target = caret.current;
    if (target === null) return;
    caret.current = null;
    const box = boxes.current[target.index];
    if (box === null || box === undefined) return;
    box.focus();
    if ('setSelectionRange' in box) box.setSelectionRange(target.at, target.at);
  });

  if (readOnly === true) {
    return <AssistantProse text={blocksToMarkdown(value)} className="aw-app-rich-text-prose" />;
  }

  const onOp = (op: RichTextOp, next?: Caret): void => {
    if (next !== undefined) caret.current = next;
    onChange?.(applyRichTextOp(blocks, op));
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>, index: number): void => {
    const block = blocks[index];
    const asked = block === undefined ? null : keyOp(event, index, block, blocks);
    if (asked === null) return;
    event.preventDefault();
    onOp(asked.op, asked.caret);
  };

  return (
    <div className="aw-app-rich-text" role="group" aria-labelledby={`${id}-label`}>
      <p id={`${id}-label`} className="aw-app-label">
        {props.label ?? strings.bodyLabel}
      </p>
      <p id={`${id}-hint`} className="aw-app-hint">
        {strings.editorHint}
      </p>
      <ol className="aw-app-rich-text-blocks" aria-describedby={`${id}-hint`}>
        {blocks.map((block, index) => (
          <BlockRow
            // A row is its place: the text boxes are controlled, so a reorder redraws their text.
            key={index}
            id={`${id}-${String(index)}`}
            index={index}
            block={block}
            strings={strings}
            onOp={onOp}
            onKey={onKey}
            textRef={(element) => {
              boxes.current[index] = element;
            }}
          />
        ))}
      </ol>
      <button
        type="button"
        className="aw-app-button"
        onClick={() =>
          onOp({ type: 'insert', index: blocks.length - 1 }, { index: blocks.length, at: 0 })
        }
      >
        {strings.addBlock}
      </button>
    </div>
  );
}
