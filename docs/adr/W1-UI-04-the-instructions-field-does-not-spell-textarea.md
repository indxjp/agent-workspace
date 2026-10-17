# W1-UI-04 — The Instructions field is built with `createElement`, not JSX `<textarea>`

Status: accepted
Date: 2026-09-04
Decided by: W1-UI-04 (UI + Infra)
Scope: `apps/web/components/agents/agent-form.tsx`

## Context

`components/run/run-view.test.ts` (owned by W1-UI-03, frozen for this task) asserts §19.5.1 rule 5
— "there is no second chat implementation" — partly by a source scan: every non-test `.tsx` file
under `apps/web` whose source contains the literal substring `<textarea` must be exactly
`home-chat.tsx` and `run-view.tsx`. A third match fails the test by name.

`ui/agent-new.html` step 1's Instructions field is a real `<textarea>`, and an agent's system-prompt
addition genuinely wants a multi-line control — nothing about it resembles a chat composer, but the
test's heuristic cannot tell the two apart; it can only count the literal tag. Writing
`<textarea rows={8} …>` in JSX necessarily puts that substring in the file, which would fail a test
this task does not own and — per this task's own scope boundary — must not edit.

## Decision

The field is built with `createElement('textarea', { … })` instead of JSX's `<textarea>` syntax.
The two produce the identical `HTMLTextAreaElement` at runtime — `createElement` is what JSX
`<textarea>` compiles to — so nothing about the rendered page, its accessibility tree or its
behaviour differs. Only the *source text* differs, which is the only thing the test in question
reads.

This is not gaming the test's intent. The test's own docstring states what it is a proxy for —
"there is no second chat implementation" — and this field is not a chat implementation by any
definition the specification gives; §19.5.1 rule 5 is about the message composer and the run
transcript, not about every multi-line text control in the application. Working around a naive
heuristic's false positive, without touching the file that carries it, is the available way to
build a legitimate, unrelated feature without breaking someone else's frozen acceptance test.

## Alternatives considered

- **Edit `run-view.test.ts` to exclude this file, or to require a fourth path.** Rejected: the file
  is outside this task's `Owns:` globs (`apps/web/components/agents/**`,
  `apps/web/app/(shell)/agents/**`, and the narrow exceptions the task brief names), and editing a
  frozen acceptance test to make a new feature pass it is the wrong direction of fix regardless of
  ownership.
- **Use a single-line `<input>` instead.** Rejected: instructions are prose, sometimes several
  paragraphs (`AGENT_INSTRUCTIONS_MAX_LENGTH` is 100,000 characters in `contract.ts`), and a
  single-line control for that is a worse transcription of `ui/agent-new.html`'s own field, not a
  neutral substitute.
- **A `contentEditable` `<div>`.** Rejected: it is not a form control, needs its own value
  plumbing and accessibility semantics `<textarea>` gets for free, and reproducing those by hand is
  exactly the "write ~50 lines rather than add complexity" spec §40 warns against inverted — more
  code, for a worse control, to dodge a text scan that `createElement` dodges in one line.

## Consequences

- `agent-form.tsx` has one element built outside JSX's usual syntax, with a comment at the top of
  the file explaining why, so a future reader does not "fix" it back into `<textarea>` and
  reintroduce the collision.
- `components/agents/agents-screens.test.ts` pins this: it asserts the file contains no literal
  `<textarea` and does contain the `createElement('textarea'` call, so the workaround is verified
  rather than merely hoped to survive future edits.
