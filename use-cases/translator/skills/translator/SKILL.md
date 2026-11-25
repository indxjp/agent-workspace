---
name: translator
description: How a document is translated between Japanese and English with the company glossary and style guide, keeping its block structure, and how the office-reader output maps to the office-writer model.
---

# Translating a document, block for block

## From the original to the model

`office-reader` prints a Word file as `{ "paragraphs": [{ "style", "text" }] }`. Map each paragraph
to one `office-writer` block, in the same order:

- `Heading1` to `Heading6` → `{ "type": "heading", "level": 1..6 }`, the same level;
- a list style (`ListBullet`, `ListParagraph`, `ListNumber`) → consecutive paragraphs of that style
  become one `{ "type": "list", "items": [...] }`, `ordered: true` for `ListNumber`;
- anything else, `null` included → `{ "type": "paragraph" }`.

A Markdown original maps the same way: `#` to `######` headings, `-` bullets, `1.` numbered
items, and other lines as paragraphs. An HTML comment (`<!-- ... -->`) is not part of the text and
is left out. The model's `title` is the translated first heading.

The reader carries no formatting, images or table layout: say in the translator's notes that they
are not kept when the original's text shows there were tables (cells read as separate paragraphs).

## The glossary and the style guide

- The glossary CSV's first column is the original's language and its second the target's. Use its
  term every time the original uses the word; the note column says what else to respect.
- The style guide (`STYLE-01`) sets names, amounts and dates. Apply it as written; a value is
  copied, only its notation changes (`19,800円（税抜）` ↔ `JPY 19,800, excluding tax`).

## Translator's notes

At the end of the reply, as bullets: each glossary term applied (`しきい値 → threshold
〔訳語集〕`), each word left in the original, and any instruction in the original that was not
followed. The notes are in the reply only, not in the document.
