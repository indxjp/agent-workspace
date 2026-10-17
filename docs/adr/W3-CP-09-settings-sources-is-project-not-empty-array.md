# W3-CP-09 — `settingSources` stays `['project']`; the plan cell's `[]` is the defect (ADR-0042)

Status: accepted
Date: 2026-09-06
Decided by: W3-CP-09 (environment)
Scope: `packages/core/src/config.ts` (unchanged by this decision); binding on whoever next edits
the Wave 3 plan's 3a-2 row for this task

## Context

The Wave 3 plan's 3a-2 row names this task's scope in its own title, not only in its
Accept cell: *"plus §25's isolation: a per-workspace `CLAUDE_CONFIG_DIR`, `settingSources: []`,
and a distinct `cwd` per session."* Taken literally, that asks `compileRunRequest` to emit
`settingSources: []`.

`packages/core/src/config.ts` already emits `settingSources: PLATFORM_SETTING_SOURCES`, and
`PLATFORM_SETTING_SOURCES` is `['project']`, landed before this task and unchanged by it. Its own
header explains why, citing R-01 (this repository's fact-checked SDK research, three rounds):

* *"`'project'` must be present: R-01 §8 and the contract summary both record that
  `.claude/skills/` and `CLAUDE.md` inside the workspace are loaded only when the `project` source
  is enabled, and spec §7 materialises a tenant's skills exactly there."*
* *"Note what this does **not** do (R-01 contradiction 6): restricting `settingSources` does not
  empty a tenant's skill surface. The bundled Claude Code skills load regardless."*

`packages/core/src/schemas.ts` (landed, not this task's) states the same finding even more
directly, on the type that models a tenant's skill surface: *"`settingSources`: spec §7's claim
that `settingSources: []` empties a tenant's skill surface is **factually wrong** — probe 2 ran
with `settingSources: []` and still received 17 bundled Claude Code skills."* `apps/runner/src/claude.ts`
carries the same probe result a third time, on the boundary that would actually set the option.

So three independently-landed files, backed by an already fact-checked research probe, agree that
`settingSources: []` does not achieve the isolation A.11/§25 want, and that `['project']` combined
with an explicit `skills` policy is what the codebase actually uses to get a tenant's skill surface
right. The plan cell's `settingSources: []` clause was written before that research was folded
into the Wave 3 plan's own prose, or without cross-checking it against `config.ts`, which
this task's `Owns` cell includes and reads before writing anything (per this wave's dispatch
instructions).

## Decision

**This task does not set `settingSources: []` anywhere, and does not touch `PLATFORM_SETTING_SOURCES`.**

This is ADR-0042's shape, applied a second time: *"when a cell's prose and its Accept line
disagree, the Accept line is the criterion and the prose is the defect."* Here the disagreement is
between the cell's own title prose and three already-landed, research-backed files this task
reads as part of its own `Owns` cell (`config.ts`) or as authoritative context (`schemas.ts`,
`claude.ts`) — the same shape ADR-0042 names, one level removed: a plan clause contradicting code
the plan itself already accepted in an earlier task, rather than contradicting its own Accept
line in the same cell. This task's actual Accept cell, read in full, never asserts
`settingSources: []` as a checked criterion — it is present only in the cell's descriptive title —
so nothing in the Accept text is left unmet by this decision.

The contradiction is stated here and in this task's PR body rather than reconciled in code, per
the wave protocol's binding instruction: *"if your cell prose contradicts its own Accept line, the
Accept line is the criterion and the prose is the defect. STATE the contradiction in your report
and stop; do not reconcile it in code."*

## Why not "fix" it by setting `[]`

Setting `settingSources: []` would:

1. Not achieve the isolation the plan cell wants it for — R-01's probe already showed the bundled
   skills load regardless, so nothing about cross-tenant `.claude` leakage would improve.
2. Silently reverse a decision three other files already made and documented, breaking
   `packages/core/src/config.test.ts`'s existing assertion `options.settingSources).toContain('project')`
   and, per that file's own comment, disable `.claude/skills/` and `CLAUDE.md` loading for every
   tenant — a regression on §7, not a fix for §25.
3. Fail to touch the actual isolation levers §25 needs, which this task implements instead:
   `packages/runtime/src/env.ts`'s per-session `CLAUDE_CONFIG_DIR` / `cwd` allocator
   (`sessionWorkspacePaths`) and its mirror in `apps/runner/src/runtime.ts`
   (`sessionScopedWorkspacePaths`), plus `apps/runner/src/claude.ts`'s pre-existing
   `strictMcpConfig: true` and `AgentSkillPolicy` allow-list, none of which this task needed to
   change to be correct.

## Consequences

* The Wave 3 plan's 3a-2 row for W3-CP-09 carries a stale clause in its title prose. The
  orchestrator amends it (drop `settingSources: []`, or replace it with `settingSources:
  ['project']` plus a pointer to R-01 contradiction 6) the same way `3a-1`'s Zod clause was
  amended under ADR-0042.
* Any later task reading this cell's title in isolation, without reading `config.ts`, would build
  the wrong isolation lever. This ADR is the record that stops that from happening twice.
