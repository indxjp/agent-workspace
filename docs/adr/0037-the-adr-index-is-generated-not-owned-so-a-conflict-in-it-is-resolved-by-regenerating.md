# ADR-0037 — The ADR index is generated, not owned: every task commits it, and a conflict in it is resolved by regenerating

Status: superseded by [ADR-0150](0150-the-adr-index-is-generated-on-demand-not-committed.md)
Date: 2026-09-05
Decided by: orchestrator, after two independent Wave 3 / Wave 4 plan reviewers raised the same finding
Scope: `docs/adr/README.md`; the `Owns` declaration of every task that writes an ADR; how a wave integration branch resolves a conflict in it

## Context

Two reviewers, on two different wave plans, independently returned the same finding: `docs/adr/README.md`
is a generated file that CI checks, every task in a wave dirties it by writing its own
`docs/adr/<TASK-ID>-*.md`, and no card owns it.

Both halves of that are true, and they pull in opposite directions.

**A task must commit it.** `.github/workflows/ci.yml` runs `sh docs/adr/regenerate-index.sh --check`
on every pull request. The generator indexes every `*.md` in `docs/adr/` except the README —
`ls "$adr_dir"/*.md | grep -v README | sort` — so a task-scoped record is indexed exactly like a
numbered one. A task that adds an ADR and does not commit the regenerated index fails that gate. And
because the file-ownership gate checks changed files against the PR's own declared globs, a task that
does commit it and does not declare it fails *that* gate instead. So `docs/adr/README.md` has to
appear on the `Owns globs:` line of every PR that adds a record. There is no third option.

**And several tasks must commit it at once.** Every task in a parallel level writes at least one ADR —
plan §3.5 and the dispatch protocol both require it — so every task regenerates the same table. Under
the rule that a parallel level's `Owns` globs must be pairwise disjoint (plan §2.3), that is an
intersection, and the honest reading is that no parallel wave can ever write an ADR.

The wave-ownership checker never caught this because the plans' ownership tables do not list the file:
they say "every task additionally owns `docs/adr/<TASK-ID>-*.md`" in prose above the table and leave
the index unmentioned. The intersection was real in every wave so far and invisible to the gate whose
job is finding intersections.

What actually happened in sub-wave 2a is visible in the history: `git log -- docs/adr/README.md` shows
the file changing in four consecutive *merge* commits into `aw/w2a-union`. Each track had regenerated
it, each merge conflicted, and each conflict was resolved. That worked, and it worked by accident of
who was paying attention rather than by a rule anyone had written down.

## Decision

**`docs/adr/README.md` is a generated artefact, not an owned file, and the disjointness rule does not
apply to it.**

Concretely:

1. **Every task that adds an ADR runs `bash docs/adr/regenerate-index.sh` and commits the result**, and
   **declares `docs/adr/README.md` on its PR's `Owns globs:` line.** Both gates then pass.
2. **Two tasks at one parallel level both declaring it is not an ownership violation** and is not a
   plan defect. A wave plan states this once, above its ownership table, in the same place it states
   the `docs/adr/<TASK-ID>-*.md` convention.
3. **A merge conflict in it is resolved by running the generator again on the merged tree** — never by
   hand-editing the table, never by `--ours` or `--theirs`. Taking one side silently drops the other
   branch's records, and the resulting index passes `--check` only until the next regeneration.
4. **The integration level regenerates it once after all merges** and commits that, so the union is
   correct even where individual conflict resolutions were not.

The test of whether a shared file belongs in this category is not "is it shared" but **"is a conflict
in it resolved by deciding, or by re-deriving?"** A conflict in `compose.yaml` needs somebody to
decide what the file should say; that is why root configuration belongs to the integration level
(ADR-0019). A conflict in a generated index needs nobody to decide anything — the merged tree already
determines the answer, and the generator computes it. The lockfile is the same category and was
settled the same way in [ADR-0017](0017-manifests-belong-to-their-package-the-lockfile-is-generated.md).

## Consequences

- Wave plans stop carrying a hidden intersection at every parallel level.
- A merge conflict in the index becomes a mechanical step with one correct resolution, rather than a
  judgement call made under time pressure at integration.
- The `--check` gate keeps its meaning. It exists because the index drifted four times before it
  existed — three times by hand, and once after the generator landed, because the generator ran on one
  branch while records were added on another. That last failure mode is exactly what item 4 closes.
- The cost is real but small: every parallel task's PR will conflict with its siblings on one
  generated file, so the integration merge is never clean. Trading a guaranteed trivial conflict for a
  possible silent drop is the right side of that trade.

## Alternatives rejected

**Give the index to the integration level and have tasks report it instead of committing it.** This
was the orchestrator's first instruction to this wave's agents and it is wrong: the task's own PR then
fails `regenerate-index.sh --check`, because the record is present on the branch and the index is not.
The instruction was corrected before any task acted on it.

**Exclude task-scoped records from the index.** Makes the gate green at the cost of the index no longer
listing 103 of the repository's decisions. The index exists to be read.

**Skip the `--check` gate on branches that add ADRs.** A gate with an exemption for the case that
trips it is not a gate. The four historical drifts are the argument.

**Have each task write its record and let the orchestrator write every index entry.** Serialises every
parallel wave through one agent for a file a script generates in under a second.

## Related

- [ADR-0003](0003-adr-naming-preserves-file-ownership.md) — why records are task-scoped in the first place.
- [ADR-0017](0017-manifests-belong-to-their-package-the-lockfile-is-generated.md) — the same
  generated-file rule, decided for `pnpm-lock.yaml`.
- [ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md) — the contrasting case: a shared
  file whose conflicts are resolved by deciding, not by re-deriving.
- [ADR-0016](0016-measured-numbers-do-not-live-in-prose.md) — the index is `--check`ed rather than
  hand-maintained for the same reason numbers are generated rather than written.
