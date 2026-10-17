# W1-CORE-01 — Tool permissions are four SDK fields, not one; spec §6 is corrected here, not silently

Status: accepted
Date: 2026-09-03
Decided by: W1-CORE-01 (Schema/Core)
Scope: `packages/core/src/{types,schemas,config}.ts`, and every later task that reads an agent's
tool permissions — W1-RN-01, W2-CP-07, the §17 Step 4 UI

## Context

Spec §6's feature-mapping table has one row for permissions:

| UI Concept       | Claude Agent SDK Concept                    |
| ---------------- | ------------------------------------------- |
| Tool permissions | `allowedTools` / permission configuration   |

R-01 §10 established, from the shipped `.d.ts` and the vendor permissions page, that reading that
row as "put the permitted tools in `allowedTools`" produces an agent that is **not restricted at
all**:

- `allowedTools` is an allow-list of **auto-approvals**, not a restriction. The shipped doc comment
  says so in as many words: *"To restrict which tools are available, use the `tools` option
  instead."*
- `allowedTools` **does not constrain `bypassPermissions`**. An unlisted tool falls through to the
  permission mode and is approved.
- Auto-approved tools **never reach `canUseTool`**, so a bare-name allow rule silently bypasses any
  callback check.
- The locked-down pairing is an allow-list **plus** `permissionMode: 'dontAsk'`: everything unlisted
  is denied outright rather than prompting into a callback nobody wired up.
- `bypassPermissions` additionally requires `allowDangerouslySkipPermissions: true`.

R-01's own contradiction list names this as item 3 and says the §6 row *"should read `allowedTools`
/ `disallowedTools` / `tools` / `permissionMode`"*. R-01 also invokes plan §5.1 rule 6: the corrected
reading is **not** to be implemented silently.

So there are two things to decide: what the type looks like, and what to do about the specification.

## Decision

**1. `AgentToolPolicy` models all four fields.** `packages/core/src/schemas.ts` declares:

```ts
{
  base: 'claude_code_preset' | ToolRule[];   // -> Options.tools           (this is what RESTRICTS)
  autoApprove: ToolRule[];                    // -> Options.allowedTools    (auto-approvals only)
  deny: ToolRule[];                           // -> Options.disallowedTools (hard removals)
  permissionMode: PermissionMode;             // -> Options.permissionMode
  allowDangerouslySkipPermissions: boolean;   // -> only with 'bypassPermissions'
}
```

The names are ours and the mapping is one-to-one; `compileRunRequest` emits all four (five with the
dangerous flag). The field that restricts is named `base`, first in the type, so the shape itself
says which one decides what the model can see.

**2. The `bypassPermissions` pairing is a schema invariant, not a convention.** `bypassPermissions`
without `allowDangerouslySkipPermissions: true` is a parse error, and the flag under any other mode
is also a parse error. Defaulting the flag to `false` is deliberate: omitting it must not become a
quieter way to ask for the mode.

**3. An unanchored wildcard is rejected in an allow list and accepted in a deny list.** R-01 §10:
`"*"` or `"mcp__*"` in `allowedTools` is *"ignored with a startup warning"* and grants nothing, while
in `disallowedTools` those globs work. A stored `allowedTools: ["*"]` is therefore a permission the
operator believes they granted and the SDK will not honour — spec §12's "never pretend", in a text
field — so `GrantingToolRule` refuses it by name and `DenyingToolRule` accepts it. This is why
`parseToolRule` returns a `wildcard` arm rather than folding one into `bare`.

**4. The specification is not edited by this task.** `docs/spec.md` is not in W1-CORE-01's `Owns`
globs, and quietly shipping the corrected model while §6 still says something else is exactly what
plan §5.1 rule 6 forbids. This record is the correction; amending §6's table is a separate PR
against `docs/spec.md`, and it is declared as an open gap on this task's pull request.

## Alternatives considered

- **Implement §6 literally: one `allowedTools` list.** Rejected. It produces an agent whose
  "permissions" screen is decorative — R-01 §10 is unambiguous that nothing would be restricted —
  and §17 Step 4's four checkboxes would then be a lie told to the operator.
- **Keep one list and derive the other three.** Rejected: the three lists answer genuinely different
  questions (what exists, what is pre-approved, what is removed) and any derivation would have to
  invent an answer to two of them.
- **Edit `docs/spec.md` §6 in this PR.** Rejected on ownership: the file belongs to no task in this
  wave's stack, and an unannounced spec edit inside a types PR is how two documents start
  disagreeing about which is current.
- **Warn on an unanchored wildcard instead of rejecting it.** Rejected under ADR-0015: a warning is
  a value that took the permissive path. The rule cannot be honoured, so it is not stored.

## Consequences

- §17 Step 4's four checkboxes are *not* this type. They remain in `agents.permissions` as the
  human-facing summary; `AgentToolPolicy` is the SDK-facing detail. The mapping between the two —
  which checkbox implies which tool rules — is a UI-wave decision and is **not** taken here.
  Declared as a gap: nothing in this wave derives one from the other.
- `docs/spec.md` §6 stays wrong until a separate PR amends it. Anyone reading §6 alone will
  under-specify permissions; this record and R-01 §10 are the correction.
- Rejecting wildcards in allow lists will reject configurations imported from a hand-written Claude
  Code `settings.json` that used them. That is the intended outcome and the error message says why.
