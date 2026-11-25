---
changelog: platform
section: Changed
---

- An evaluation case's `judge` now grades the run, not only its answer: the judge prompt also holds,
  as evidence, every tool call of the run with its input and status (`completed`, `error`, `failed`
  or `no_result`), the call the run stopped on for approval, and the run's structured output, each
  always present and `(none)` when empty (ADR-0175). A rubric can therefore check the content of a
  paused `Write`, the arguments of a gated call, or that a tool was not called. The evidence is
  JSON with `<`, `>` and `&` escaped, so nothing in it can close its section, and the judge's system
  instruction names it as data, never instructions. A section tag inside the answer, the input or
  the rubric reaches the judge as inert `&lt;…&gt;` text, so a reply cannot forge a section. Each call, the paused call and the structured
  output are cut at 8,000 characters with a marker, and the calls together at 32,000. `aw eval`, the
  SDK and the Builder use the same server path; the evaluation contracts are unchanged.
