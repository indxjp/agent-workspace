# W1-COMP-01 — §17's permission checkboxes compile to `disallowedTools`, not to `allowedTools`

Status: accepted
Date: 2026-09-03
Decided by: W1-COMP-01 (the composition root)
Scope: `apps/web/server/compose/run-request.ts` (`toolPolicyFor`, `agentConfigFor`)

## Context

`agents.permissions` is spec §17 Step 4's four booleans — `readFiles`, `writeFiles`,
`runCommands`, `unrestrictedNetwork` — and until this task nothing turned them into anything. The
composition root has to, because `RunRequest.agent` requires an `AgentToolPolicy` and the runner
refuses a body without one.

§6's mapping table says *"Tool permissions → `allowedTools`"*. R-01 §10 established that this is
incomplete, and `packages/core/src/schemas.ts` already carries the distinction in
`AgentToolPolicy`'s own field comments: `base` is *"the surface the model can see at all. This is
the field that restricts"*, `autoApprove` is *"auto-approvals"* and grants no tool that `base` does
not expose, and `deny` is *"hard removals — the definition never reaches the model."*

The trap is that `allowedTools` **auto-approves**; it does not restrict. An agent whose `readFiles`
is false, expressed by leaving `Read` out of `allowedTools`, can still read a file the moment a
permission prompt is answered — and a platform run has nobody to answer it, so the SDK's behaviour
there is a property of `permissionMode`, not of the checkbox.

## Decision

**A permission that is off puts its tools in `deny`.** `readFiles` → `Read`, `Glob`, `Grep`;
`writeFiles` → `Write`, `Edit`, `NotebookEdit`; `runCommands` → `Bash`, `BashOutput`, `KillShell`;
`unrestrictedNetwork` → `WebFetch`, `WebSearch`. `autoApprove` stays empty, `base` stays the Claude
Code preset because §5 makes the SDK's own tool surface the product, `permissionMode` stays
`default`, and `allowDangerouslySkipPermissions` is never set — R-01 §10 makes it the flag
`bypassPermissions` additionally requires, and nothing in Wave 1 has a reason to reach for either.

`run-request.test.ts` asserts the direction rather than the list: all four permissions on denies
nothing, all four off denies a member of each group, one permission off denies only its own group,
and no combination asks for `bypassPermissions`.

## This is a floor, and the floor is the honest part

**The mapping is not the finished §17 Step 4.** Four booleans do not cover the SDK's tool surface,
and the four groups above are the tools those four sentences plainly name — not a proof that no
other tool can read a file. `Task` can, transitively, by delegating to a subagent; an MCP
connector can, and `mcpServers` is empty in this wave only because `agent_mcp_servers` is a Wave 2
table. So `readFiles: false` means *the file-reading tools named above are gone*, which is a
smaller claim than *this agent cannot read a file*, and the screen that offers the checkbox should
not say the larger one.

**Nothing enforces that a fifth checkbox reaches this function.** `AgentPermissions` is a Zod
object read here by field name, so adding a capability to it compiles and produces an agent whose
new permission governs nothing. A `switch` with a `never` default is the usual defence and there is
no discriminant here to switch on. What exists instead is this paragraph, a gap on this task's PR,
and a test that fails the moment the four known names stop being denied.

## Alternatives rejected

* **Follow §6 literally and populate `allowedTools`.** It is what the specification's table says
  and R-01 §10 measured why it does not do the job. A permission that only withholds an
  auto-approval is not a permission in an unattended run.
* **Restrict `base` to an explicit tool list instead of the preset.** It would be the tightest
  answer and it means this file deciding, per agent, which of the SDK's tools exist — a product
  decision belonging to §17's screen, taken in a wiring file, and one that silently drops any tool
  a future SDK release adds to the preset.
* **Put the mapping in `packages/core`.** Arguably its home: `compileRunRequest` already lives
  there and this is the same kind of translation. It is not this task's package, the manifest and
  the module surface are W1-CORE-01's, and moving it later is a file move. Declared as the
  preferred destination rather than done here.
* **Send `permissions` and let the runner decide.** Two places deciding one thing. `AgentConfig`
  already carries both the human-facing summary and the SDK-facing detail, and
  `packages/core/src/schemas.ts` says why: the summary is shared with the column, the detail is
  what the SDK is given.
