---
changelog: aw
section: Fixed
---

- `aw agents new --from-prompt` shows each check it asks you to run in full (name, input and
  expectation), and writes every control, hidden, zero-width, bidirectional, tag or look-alike space
  character in the text it asks you to approve as `<U+XXXX>` instead of deleting it, so two rules
  that differ only by an invisible character no longer look the same and an escape sequence cannot
  hide text.
- The commands that print a run's events (`aw runs start`, `aw runs events`, `aw runs follow`) drop
  control and escape sequences from the text they print, as do the human tables of `aw runs get`
  and the other listings.
