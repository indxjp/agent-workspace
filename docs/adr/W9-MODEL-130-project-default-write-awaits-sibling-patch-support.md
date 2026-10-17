# ADR-W9-MODEL-130-project-default-write-awaits-sibling-patch-support — the project-settings model control sends the real pair now, and the save flow proves whether it took effect

Status: accepted
Date: 2026-09-12
Decided by: W9-MODEL-130
Scope: `apps/web/components/projects/{model,project-form,project-detail}.tsx`

## Context

The card places a project-layer model default in "the project settings form." `projects`'s
`defaultModelConnectionId`/`defaultModel` columns exist (`#129`), and the run-composition path
already reads them (`apps/web/instrumentation-node.ts`'s `project.defaultModelConnectionId` read,
inside `W9-PROJ-125`'s own domain but landed by `#129`). What is missing is the *write* path:
`apps/web/server/projects/http.ts`'s `parseProjectPatch` (owned by `W9-PROJ-125`, this task's
same-wave sibling in Wave 9.4 — not a sequential predecessor, so this file cannot be touched under
any declaration this task could make) does not recognise either field on a `PATCH` body.
`parseProjectPatch` has no "reject unknown keys" guard (unlike `apps/web/server/runs/api.ts`'s
`parseStartRunBody`, which does): an unrecognised key is silently dropped from the constructed
patch object, not refused. A `PATCH` that includes `defaultModelConnectionId`/`defaultModel` today
answers `200`, with every other field applied and those two silently unchanged.

`packages/core/src/db/repositories/projects.ts`'s `UpdateProjectPatch` type already includes both
fields, with a comment `W9-MODEL-129` left for exactly this task: *"the caller (this task has none
in its own Owns globs; a later task's route enforces the pair) is responsible for never sending one
without the other."* That comment names this task as the intended caller and `W9-PROJ-125`'s route
as the intended enforcer — confirming the write path was always meant to be two tasks' work
meeting in the middle, not one task's alone.

## Decision

Build the control as if the write path already works: `ProjectDraft.defaultModel` is a real,
always-submitted field (never a third "untouched" state, matching every other field
`buildProjectPatch` already sends), `buildProjectPatch`'s return type is widened locally
(`ProjectPatchInput & { defaultModelConnectionId; defaultModel }`, since the imported
`ProjectPatchInput` is `W9-PROJ-125`'s own type and not this task's to edit) to carry the pair, and
`project-detail.tsx`'s save flow checks the response it gets back: `projectModelSaveTookEffect`
compares what was requested against what the server actually returned. When they disagree — the
server accepted the request and silently dropped the field — the screen reports exactly that,
reverts the draft to the value that is genuinely saved, and leaves every other field's save
standing (ADR-0015: a `200` is not proof a specific field changed; it is checked).

## Alternatives considered

- **Wait for `W9-PROJ-125` to land and touch nothing here.** Rejected: `#130`'s Acceptance
  Criteria requires a project settings model control now, in this same wave, and the two tasks run
  in parallel — waiting on a sibling with no defined merge order would stall this task
  indefinitely.
- **Send the request and trust the `200`, the same way every other field already does.** Rejected:
  it is exactly the dishonest control `../agents/model.ts`'s header and this file's own header
  already refuse elsewhere — a save that looks like it worked and did not.
- **Touch `apps/web/server/projects/http.ts` directly, declaring it out-of-globs.** Rejected: it is
  a same-wave sibling's exclusively-declared file, the same hard boundary
  `docs/adr/W9-MODEL-130-workspace-default-has-no-write-api-in-this-wave.md` describes for
  `instrumentation-node.ts` — not a file this task may touch under any declaration.

## Consequences

- Until `W9-PROJ-125` accepts the two fields, a person who sets a project default sees an honest
  "did not save" message and the control reverts — a worse first impression than a silent success,
  and the correct one.
- The moment `W9-PROJ-125`'s `parseProjectPatch` recognises `defaultModelConnectionId`/
  `defaultModel`, this task's client starts working with no further change: the body it already
  sends is the one that route needs to accept.
