# W1-UI-04 — The new-agent screen is one step, not §17's five-step wizard

Status: accepted
Date: 2026-09-04
Decided by: W1-UI-04 (UI + Infra)
Scope: `apps/web/app/(shell)/agents/new/page.tsx`, `apps/web/components/agents/agent-form.tsx`

## Context

`ui/agent-new.html` draws the whole of spec §17's wizard: Agent, Model, Capabilities, Permissions,
Runtime. PL-0 fixes layout, labels and navigation order for a screen this task transcribes, and
does not ask for a redesign.

But §17 is the *general* agent-management feature, not Phase 0's contract. Spec §46 Phase 0's
completion criterion is narrower and is quoted in full in `components/agents/model.ts`:

```text
Create Agent → enter instructions → select Claude → Run → receive streamed result
```

Three of the wizard's five steps have nothing real to stand on in this wave:

- **Capabilities** offers Files, Skills and Connectors. None of the three has a management screen
  in Wave 1 — all three remain inert sidebar entries (`components/shell/navigation.ts`).
- **Permissions** offers four checkboxes with no wizard step before it to have picked capabilities
  for them to gate.
- **Runtime** offers a sandbox profile. `runtimes` is likewise inert, and Wave 1 has no `docker`
  driver to run one on (`compose.yaml`).

A picker whose every option points at a screen that does not exist is not a simplification of the
wizard — it is either non-functional controls or invented data, both refused by ADR-0015.

## Decision

The new-agent screen has one visible step: **Agent** (Name, Instructions — §17 Step 1, transcribed
verbatim including its help text), followed by a non-interactive **Model** section that states
"Claude" as the model this deployment is configured for. There is no step indicator, no Continue
button and no multi-step state machine — the whole screen is one `<form>`.

This satisfies §46's literal sequence: a person types instructions, sees Claude named as the model,
and submits — "enter instructions → select Claude" — without asking them to configure four things
this deployment cannot yet act on.

## Alternatives considered

- **Build all five steps; disable the three that have nothing behind them.** Rejected: a disabled
  step in an otherwise-live wizard reads as "coming soon", which is a promise about a scope this
  task does not own and a later wave may resolve differently.
- **Build all five steps against invented workspace data (fake files, fake connectors).** Rejected
  outright by ADR-0015 and by `ui/agent-new.html`'s own status as demonstration content, not data
  — see `components/composer/home-chat.tsx`'s header for the established precedent.
- **Wait for Files/Skills/Connectors/Runtimes to land, then build the wizard once.** Rejected:
  spec §46 is explicit that Phase 0 must work "reliably" with none of that, and this task's mandate
  is closing the Phase 0 blocker now, not deferring it again.

## Consequences

- An agent created through this screen cannot be given files, skills, connectors, elevated
  permissions or a non-default runtime in this wave. That is consistent with the rest of the
  product surface today — none of those subsystems has a UI yet — and is not a regression this
  screen introduces.
- When Files, Skills, Connectors and Runtimes gain real screens, the wizard described in §17 has a
  natural home to grow into; this screen does not have to be discarded, only extended.
