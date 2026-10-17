# W1-UI-04 — The new-agent form has no Description field

Status: accepted
Date: 2026-09-04
Decided by: W1-UI-04 (UI + Infra)
Scope: `apps/web/components/agents/agent-form.tsx`

## Context

`ui/agent-new.html` step 1 shows three fields: Name, Description (marked optional), Instructions.
`apps/web/server/agents/contract.ts`'s `CreateAgentInput` — the frozen W1-CP-05 wire contract this
task must wire to, not redesign — has exactly two string fields: `name` and `instructions`. There
is no `description`, and the `agents` table §17 describes has none either.

## Decision

The form omits the Description field. Only Name and Instructions are rendered.

An input with nothing behind it is a small version of the dishonesty §43 already names for
navigation: it looks like it does something, and it does not. Rendering it, collecting a value,
and then discarding that value on submit (because `POST /api/agents` has no field for it and would
reject an unknown key per `unknownKeyErrors` in `contract.ts`) would be worse than omitting it —
it is a control that silently forgets what a person typed into it.

## Alternatives considered

- **Render it and drop the value client-side before sending.** Rejected: this is the "silently
  discarded" failure stated above, just performed one layer earlier.
- **Render it and fold it into `instructions` (e.g. as a prefixed line).** Rejected: this invents a
  text convention the API, the store and every other reader of `instructions` knows nothing about,
  and it would resurface as a stray line in the agent's system prompt the moment a run happens.
- **Ask W1-CP-05 to add the field.** Out of scope: `server/agents/**` is frozen and owned
  elsewhere, and this task's brief is explicit that its files are not to be touched.

## Consequences

- The new-agent screen is one field shorter than the mockup shows. Nothing is lost that could
  otherwise have been kept — there is nowhere for a description to go once submitted.
- If a later wave adds `agents.description` to the schema and the contract, this field returns as
  a normal transcription with a real destination.
