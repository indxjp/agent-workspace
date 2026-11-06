---
changelog: react
section: Added
---

- `AttachmentChips` and `ToolTrace`, with `AttachmentChipsProps` and `ToolTraceProps`: the
  attachment chips and the tool trace `<Chat/>` draws, exported as parts so another chat draws the
  same ones. `AttachmentChips` takes `{ id, name }` items and a remove callback, draws no wrapper,
  and takes class names, a glyph and a title for a host's own look. `<Chat/>`'s markup is
  unchanged.
