# W1-UI-03 — A message body is paragraphs of typed inline runs, not Markdown

Status: accepted
Date: 2026-09-03
Decided by: W1-UI-03 (UI)
Scope: `apps/web/components/run/model.ts`, `apps/web/components/run/run-view.tsx`

Amended by [ADR-0141](0141-assistant-prose-renders-as-markdown-without-raw-html.md) (issue
#1131): assistant text renders as Markdown through `react-markdown` with an element allow-list and
no raw HTML. User text and fact notes stay literal.

## Context

The transcript in `ui/agent-run.html` carries formatted prose. Counted from the file, the message
bodies use exactly two inline constructs and no others:

```text
<b>                    the lead-in of each numbered contract; the two deviations
<span class="mono">    contracts/2026-q3/ in the question; the written output path
```

Real agent output is Markdown. The obvious reading of "render the agent's answer" is therefore
"render Markdown", and the obvious implementation is a Markdown parser plus an HTML sanitiser —
because agent output is untrusted text and rendering it as HTML without sanitising is a stored-XSS
hole on the one screen every user of the product looks at.

§40 makes ~50 lines of clear code the rule and reserves dependencies for cryptography, JWT, OAuth,
database clients and container protocols. A Markdown stack is none of those, and the honest version
of it is two libraries, not one.

## Decision

A paragraph is `readonly Inline[]`, and an `Inline` is `{ text, strong, mono }`. The component maps
each run to `<b>`, to a `.mono` span, or to a plain span. There is no HTML string anywhere in the
run view and nothing is ever passed to `dangerouslySetInnerHTML`.

The vocabulary is the mockup's, exactly: two flags, because the mockup uses two constructs. It is
not a general rich-text model and is not meant to grow into one by accretion.

This also disposes of the sanitiser question rather than deferring it. Text reaches the DOM as a
React text node, so a message containing `<script>` renders as the characters `<script>` — not
because a filter caught it, but because there is no code path on this screen that turns a string
into markup. That is a structural guarantee rather than a check that can be forgotten, which is the
form ADR-0015 asks for.

## Alternatives considered

- **A Markdown renderer plus a sanitiser.** Rejected under §40 for this wave. It is the right answer
  eventually — agents emit lists, code fences and tables, and none of those are representable here —
  but it is a decision about untrusted-content handling that deserves its own task and its own
  threat model, not a line in a UI transcription task.
- **Write a small Markdown subset parser by hand (~50 lines).** Rejected, and this is the one that
  looks most attractive. A partial Markdown parser is worse than none: it sets the expectation that
  Markdown works, and the first construct it does not implement renders as literal asterisks in
  front of a user. §40's ~50 lines are for problems that are actually small; correctly parsing a
  subset of Markdown is not one, and the boundary of the subset would be invented by whoever wrote
  it.
- **Store the body as an HTML string and render it.** Rejected: stored XSS on the transcript screen.
- **Model only `<b>` and let the paths render in the body font.** Rejected after comparing the two
  screens side by side — the monospace path is how the mockup distinguishes an identifier from
  prose, and losing it was visible in the first draft.

## Consequences

- **The run view cannot render a list, a heading, a code block or a link.** An agent that emits one
  today produces a paragraph containing its Markdown source. This is the largest single gap in this
  task and it is declared as one; it is not visible in the mockup comparison, because the mockup's
  answer happens to contain neither.
- Whoever builds streaming has to decide what an SDK `assistant.text` event becomes. The type says
  what the screen can show, which is the useful half of the answer.
- Replacing this with a real Markdown pipeline is a change to two functions — the paragraph type and
  the component that renders it. Nothing else in the run view touches prose.
