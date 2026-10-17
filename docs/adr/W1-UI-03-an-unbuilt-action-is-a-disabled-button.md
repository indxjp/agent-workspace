# W1-UI-03 — An action nothing has built renders as a disabled button, not a live one

Status: accepted
Date: 2026-09-03
Decided by: W1-UI-03 (UI)
Scope: `apps/web/components/run/run-view.tsx`

## Context

`ui/agent-run.html` puts five controls on this screen that do something no Wave 1 task ships:

```text
Interrupt                header      → data-toast="Interrupt sent to the sandbox"
Sessions                 header      → opens the §20 sessions modal
Attach file              composer    → data-toast="File picker opened"
Resume another session   composer    → opens the same modal
Download                 rail        → data-toast="Downloading…"
```

In the mockup each is a `data-toast` demonstration — it prints a message and changes nothing. The
capability behind each is genuinely absent on this branch: `apps/web/app/api/runs/[id]/` exposes
`GET` for the run and `GET` for its event stream, and no interrupt route; §20's session list has no
screen; there is no file upload and no object-storage download path.

The shell and the composer have each already answered the neighbouring question. A navigation entry
with no destination renders disabled rather than as a link
([W1-UI-01](W1-UI-01-a-navigation-entry-with-no-destination-is-disabled.md)), and so do the
composer's three in-panel links
([W1-UI-02](W1-UI-02-unbuilt-destinations-are-not-links.md)). Neither covers an *action*, which is
not a destination and has its own idiom in the design system.

## Decision

Each of the five renders as a real `<button disabled>` carrying `.btn[disabled]` from
`ui/assets/app.css` — `opacity: .45; pointer-events: none` — with the mockup's label copied
unchanged. The **Send** button under the run transcript is the same: there is no follow-up to send
until a run API is wired to this screen.

This is the design system answering for itself. A disabled button is what `.btn[disabled]` is for,
it is visually distinct from the `.62` treatment the shell uses for an inert *label*, and the
distinction is meaningful: a greyed navigation item says "that page is not here", a greyed button
says "you cannot do that yet".

Whether an action is available is data — `UnbuiltAction` on a `Run` — rather than a constant in the
component. When W2 builds interrupt, the screen does not change shape; a value does.

## Alternatives considered

- **Wire the buttons to toasts, as the mockup does.** Rejected. The mockup's toast is a *device for
  demonstrating a static page*, not a specification of behaviour; a shipped button that says
  "Interrupt sent to the sandbox" when nothing was sent is a lie, and precisely the kind §43 is
  written against.
- **Omit the buttons.** Rejected: they are transcribed copy, the header reads as unfinished without
  them, and their absence would hide from a reviewer that these are the five things still missing.
  A visible disabled control is a more honest inventory than a gap.
- **Invent a tooltip explaining why each is disabled.** Rejected under §43 and plan §10 risk #10 —
  the calm, sparse property is lost one convenience at a time, and the mockup shows no tooltip.
- **Use `.62` and a `<span>`, matching W1-UI-01 and W1-UI-02 exactly.** Rejected: those are labels
  that would otherwise be links. Rendering a button as a span loses the semantics a screen reader
  needs, and `.btn[disabled]` already exists for exactly this case.

## Consequences

- The run view is visibly less interactive than the mockup, and a reviewer comparing the two
  side by side sees five greyed controls. That is the accurate picture of Wave 1.
- Turning one on is a data change plus a handler: the button, its label and its position do not
  move.
- `disabled` removes the control from the tab order. For five actions that cannot be taken this is
  correct, but it means the screen has fewer focus stops than the finished one will — worth knowing
  before anyone measures keyboard navigation against the mockup.
