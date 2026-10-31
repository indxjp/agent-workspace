---
changelog: sdk
section: Added
---

- `@indx-workspace/sdk/portable` exports `revealInvisible` and `stripControlSequences`, which make
  model-written text safe to show. `revealInvisible` is for a screen where a person approves
  something: every control, zero-width, bidirectional, tag, variation-selector and look-alike space
  character is written as `<U+XXXX>` and nothing is deleted. `stripControlSequences` drops the escape
  sequences a terminal would act on, for streamed output.
