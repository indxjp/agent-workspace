# W1-RN-01 — The tenant skill surface is narrowed by `skills`, not closed by it

Status: accepted
Date: 2026-09-03
Decided by: W1-RN-01 (Runner)
Scope: `apps/runner/src/claude.ts`; spec §7 and §25's multi-tenancy claims; every later task that
states what a tenant agent can reach

## Context

R-01 contradiction 6 is the one place the research says the specification is *factually wrong*
rather than incomplete: any §7 or §14 text treating `settingSources: []` as the way to give a
tenant an empty skill surface is false, because the bundled Claude Code skills load regardless.
W1-RN-01's first version took the correction and stopped one clause too early. `claude.ts` said
*"Only `skills` closes the surface"*, and `toSdkSkills`' rejection message told the caller to
*"Emit `'all'` or an explicit allowlist (which may be `[]`)"* with nothing after it.

R-01 §8 does not say that. Two of its bullets say the opposite, in the same paragraph the branch
cited:

> Dispatch by name (`/<skill>` in the prompt) works **even when the `skills` list omits it**. A
> skills allowlist is therefore not a security boundary for user-typed prompts.

> The skill surface is closed with **`skills: []`**, or narrowed with an explicit `skills: [...]`
> list, not with `settingSources`. Neither closes user-typed `/name` dispatch.

`startRun()` passes the tenant's `prompt` string straight into `query({ prompt })`. The tenant
therefore controls the one input that reaches the path no option value closes. That is the same
§7/§25 multi-tenancy hole R-01 raised, moved one lever to the right.

R-01 also graded all of this **documented, not probed** — including the half that turns out to be
true — so shipping either claim flatly was asserting a capability on a scenario nobody had run.

## Decision

The platform states three separate facts about the skill surface, and states them wherever it
makes the claim: in `claude.ts`'s header, in `toSdkSkills`' rejection message, and in this record.

1. **`settingSources` is not the lever.** `settingSources: []` loads no *user or project
   filesystem* skills and still loads the bundled Claude Code skills. So a compiled options object
   that omits `skills` is refused by `toSdkOptions` rather than forwarded: absence would grant the
   bundled set through both paths below.
2. **`skills: []` closes the model-invoked path, and only that path.** The `Skill` tool refuses a
   name that is not on the list, with an error the model sees. This is now probed, not assumed.
3. **No option value closes user-typed `/name` dispatch, and `system/init` cannot be used to audit
   it.** A tenant prompt beginning `/dataviz` loads that bundled skill with `skills: []` in force.
   `system/init` → `skills` reports the same list whether the option is `[]` or `'all'`, so R-01
   §8's own advice — *"Confirm what loaded by reading `system/init` → `skills`"* — does not work
   against this lever.

Fact 3 is **not fixed by this task**. It is named as an open spec §7/§25 item: closing it needs
prompt-level dispatch filtering, which belongs with whoever owns the tenant prompt path, and
inventing a filter here would be a new tenant-facing refusal invented by a translation module with
no spec text behind it. What this record buys is that nothing in the codebase claims otherwise.

## Alternatives considered

- **Refuse a tenant prompt whose first token looks like a slash command.** Rejected for this task,
  with reservations. It is a real mitigation and it is also a behavioural change to every tenant
  run, decided by the file whose entire job is translation, on a guess about the dispatcher's
  grammar that no probe here establishes. A wrong guess is a gate that fails open (a spelling that
  still dispatches) or a platform that refuses legitimate prompts beginning with a path. The
  honest sequence is: record the hole, then close it where the prompt is owned, against a probe of
  what actually dispatches.
- **Say nothing, on the grounds that `skills: []` is still the right value to send.** Rejected —
  that is the defect this record exists to correct. A reviewer who reads "only `skills` closes the
  surface" stops looking, which is exactly the harm an overstated capability does.
- **Drop `skills` handling entirely and let spec §7 be wrong.** Rejected: fact 2 is real and worth
  having. Narrowing the model-invoked path is most of the value, and it is now evidenced.

## The honest downside

The platform ships a §7/§25 multi-tenancy hole it has named and not closed, on a path the tenant
controls. Bundled skills reachable this way include `run`, `debug`, `code-review`, `schedule` and
`workflow-authoring`, several of which drive shell and process execution — so the exposure is not
theoretical, and it is bounded only by whatever sandbox and `tools` restrictions the run already
has. The `tools` list still gates what those skills can *do*: S8 below shows the model-invoked
path refused under `tools: { type: 'preset', preset: 'claude_code' }`, and every durability
scenario in the sibling record ran with `tools: []`, where a loaded skill has nothing to execute
with. That is a mitigation, not a closure, and no probe here measured what a dispatched skill can
reach under a restrictive `tools` value.

Second: this record's evidence is one host, one OS, one account, one SDK version, and the
dispatcher's behaviour is CLI-internal — it is not in `sdk.d.ts`, so nothing in
`tests/sdk-surface.test.ts` will notice if it changes. Fact 3 must be re-probed on the Linux runner
image and on every SDK bump, alongside R-01's own re-verify list.

## Evidence — five live scenarios

Run 2026-09-03 on Windows 11, Node v24.19.0, one OAuth account, SDK 0.3.258 (Claude Code 2.1.258),
model `claude-haiku-4-5`, through `startRun()`. Real output, unedited except for line wrapping.
The probe is reproduced in full in `W1-RN-01-session-durability-is-a-verdict.md`.

```text
--- S5 skills:[] + a user-typed /dataviz ---
  COMPILED_SKILLS: []
  PROMPT: "/dataviz\nIn one sentence, say which skill you just loaded."
  INIT_SKILLS: ["deep-research","design-sync","dataviz","update-config","verify","debug",
                "code-review","simplify","batch","fewer-permission-prompts","doctor","loop",
                "schedule","claude-api","workflow-authoring","run","run-skill-generator"]
  ASSISTANT_TEXT: "I just loaded the **Data Visualization** skill, which provides a
    design-system-agnostic procedure for creating charts that are right by construction through a
    validated method covering form selection, color assignment, mark specifications, interaction
    design, and accessibility."

--- S6 skills:"all" + the same prompt ---
  COMPILED_SKILLS: "all"
  INIT_SKILLS: (byte-identical to S5's list)
  ASSISTANT_TEXT: "I just loaded the Data Visualization skill, which provides a procedure for
    creating readable, accessible charts through form selection, color assignment, validation,
    mark specifications, interaction patterns, and accessibility checks."

--- S7 control: skills:[] + a name that is not a skill ---
  COMPILED_SKILLS: []
  PROMPT: "/zzz-not-a-skill\nReply with one sentence."
  ASSISTANT_TEXT: "Unknown command: /zzz-not-a-skill"

--- S8 skills:[] + the model-invoked Skill tool ---
  COMPILED_SKILLS: []
  PROMPT: "Use the Skill tool to load the skill named claude-api, then reply DONE."
  TOOL_USES: ["Skill({\"skill\":\"claude-api\"})"]
  TOOL_RESULTS: ["is_error=true <tool_use_error>Skill claude-api is not in this session's skills
                  allowlist</tool_use_error>"]

--- S9 skills:["claude-api"] + the model-invoked Skill tool ---
  COMPILED_SKILLS: ["claude-api"]
  TOOL_USES: ["Skill({\"skill\":\"claude-api\"})"]
  TOOL_RESULTS: ["is_error=false Launching skill: claude-api"]
  ASSISTANT_TEXT: "DONE"
```

S7 is what makes S5 evidence rather than an anecdote. Without it, "the model said it loaded the
skill" is a sentence a model can produce for any reason; with it, the same prompt shape returns the
dispatcher's own refusal for a name that is not a skill, so S5's reply is real slash dispatch and
not confabulation. S8 against S9 is the same construction one lever over: the *only* difference
between the two runs is the allowlist, and the tool result flips from an error to a launch.

Three R-01 rows change grade:

| R-01 row | Was | Now |
| --- | --- | --- |
| `skills: []` closes the model-invoked path | documented, not probed | **verified (probe — executed)** — S8 vs S9 |
| `/name` dispatch bypasses the allowlist | documented, not probed | **verified (probe — executed)** — S5 with the S7 control |
| `system/init` → `skills` confirms what loaded | documented (R-01 §8's advice) | **refuted (probe — executed)** — identical under `[]` and `'all'`, S5 vs S6 |
