---
changelog: react
section: Changed
---

- `AttachmentChips` draws a read-only row when it is given no `onRemove`: each chip is its name
  alone, with no remove button. `onRemove` and `removeLabel` are now optional, and a remove button
  is drawn only when both are given. Existing callers, which pass both, render unchanged.
