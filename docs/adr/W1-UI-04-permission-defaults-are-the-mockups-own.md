# W1-UI-04 — The simplified form's permission defaults are §17 Step 4's own default state

Status: accepted
Date: 2026-09-04
Decided by: W1-UI-04 (UI + Infra)
Scope: `apps/web/components/agents/model.ts` (`DEFAULT_AGENT_PERMISSIONS`)

## Context

`POST /api/agents` requires all four `AgentPermissions` keys on every request —
`parseAgentPermissions` in `contract.ts` rejects a missing key by name, and its own comment states
why: "an agent whose permissions nobody chose is an agent whose blast radius nobody chose." This
task's simplified form (see
[W1-UI-04-a-simplified-form-not-the-wizard.md](W1-UI-04-a-simplified-form-not-the-wizard.md)) has
no Permissions step, so nothing on screen lets a person choose them.

Something must still be sent. The question is where the four booleans come from.

## Decision

The four values are §17 Step 4's own default *state*, transcribed from `ui/agent-new.html` rather
than chosen fresh: `class="check on"` is present on "Read files" and "Write files" and absent from
"Run commands" and "Access unrestricted internet" in the mockup's own markup, unconditionally, as
the wizard's starting selection before anyone interacts with it. `DEFAULT_AGENT_PERMISSIONS` in
`model.ts` reproduces exactly that:

```text
readFiles: true, writeFiles: true, runCommands: false, unrestrictedNetwork: false
```

This is PL-0's decision, not this task's. What this task decided is to apply it without rendering
the checkboxes that would let someone change it — the same "less than the mockup, stated" pattern
`components/composer/home-chat.tsx`'s header already establishes for this codebase.

## Alternatives considered

- **All four `false` (narrowest possible).** Rejected: it is not what the mockup's own default
  state shows, and choosing it here would be inventing a *different* default rather than
  transcribing the one PL-0 already made.
- **All four `true` (widest possible).** Rejected for the same reason, and additionally because
  `run-request.ts`'s `toolPolicyFor` maps `runCommands`/`unrestrictedNetwork` onto real `Bash`,
  `WebFetch` and `WebSearch` access — granting both by default for every agent this form creates
  is a materially larger blast radius than the mockup's own starting point.
- **Prompt for them via a native `confirm()` or similar out-of-band UI.** Rejected under §40 and
  §43: an unstyled browser dialog is not a screen, and this is exactly the kind of control a real
  Permissions step should own once one exists.

## Consequences

- Every agent this form creates can read and write files inside its sandbox, and cannot run shell
  commands or reach the open internet, until a later wave's Permissions step lets an operator
  change it on that agent directly (`PATCH /api/agents/:id`, already wired by W1-CP-05).
- If PL-0's own default in `ui/agent-new.html` ever changes, `DEFAULT_AGENT_PERMISSIONS` should
  change with it — the two are supposed to agree, and `model.test.ts` pins the current value so a
  future drift is visible as a failing assertion rather than a silent divergence.
