# ADR-0011 — Two PRs were merged to `main` under a parallel Owner instruction; the stack was restacked onto them

Status: accepted (attribution corrected 2026-09-03 — see "Correction" below)
Date: 2026-09-03
Decided by: orchestrator
Scope: Wave 0 recovery; branch handling for every later wave

## Context

Plan §8.6 states: *"Merging is a human action (Owner or Platform Lead), or an explicitly authorised
batch merge of an all-green stack. Agents do not merge."*
[ADR-0001](0001-no-merge-to-main-wave-integration-branches.md) went further — the Owner decided
nothing merges to `main` at all.

Two PRs nonetheless reached `main`:

| PR | Merged at | Content |
| --- | --- | --- |
| #1 | 2026-09-02T17:45:05Z | R-03 research note |
| #2 | 2026-09-02T18:10:37Z | W0-INF-01 monorepo skeleton |

Each was squash-merged **with `--delete-branch`**, which turned a policy divergence into a structural
break: `aw/w0-01-monorepo` was PR #6's base, so deleting it left #6 `CLOSED` and `CONFLICTING` and
orphaned the four branches above it from `main`.

## Correction — who actually did this

This record originally stated the merges were "attributable to a wave agent and not to the
orchestrator", reasoning that the orchestrator's own merge attempt had been refused by the harness's
permission layer, so the only remaining actor was an agent.

**That inference was wrong, and it was wrong in the way this programme most often goes wrong: a
conclusion drawn from an incomplete enumeration and then stated as fact.** The enumeration omitted
the possibility of another session. `ListAgents` shows two further Claude sessions on this
repository, and the one named *"claude-agent-workspace stacked PRs review and merge"*
confirmed on request that the merges were its own.

The full account it gave, which supersedes every guess this record originally made:

- It was opened with an explicit Owner instruction to *sequentially review, fix, and merge the eight
  stacked PRs*, one at a time, and to ask before the first merge so the strategy could be confirmed.
- It asked. The Owner answered two questions before PR #1: merge strategy = **squash + delete
  branch**, and, because #1–#5 had no CI at that point in the stack, **CI absence is acceptable,
  proceed on local verification**.
- It had first checked the repository for a merge policy and found plan §8.6 — *"Squash-merge each
  PR"*, *"Bottom-up only"* — which is what it quoted back when asking.
- It could not have read ADR-0001. That record had not landed anywhere reachable: `main` was
  `159b21a → 4c027c5 → 9888b16`, and this session's decision log existed only on an unmerged branch.

So there was no rogue actor and no violated rule. There were **two regimes, each separately
authorised by the same Owner, neither able to see the other** — and the one written down where the
other could read it was §8.6, which says to merge. After PR #2 the peer discovered the #6 closure
and the orphaning, stopped of its own accord, reported it, and the Owner replaced its instruction
with *"do not merge; keep updating the PRs one at a time."* It has merged nothing since. The two
regimes now agree.

The original wording is left visible rather than deleted, because an ADR that quietly rewrites its
own history is worth less than one that shows where it was wrong. The operational conclusions below
are unchanged; only the attribution moves — and the lesson sharpens: this session published a rule
in a place no other writer could read, then recorded a violation when someone followed the rule that
*was* readable.

## Decision

1. **Accept the two merges.** Reverting a squash-merge on a shared trunk to restore a policy is worse
   than the divergence: the content is correct, verified, and already the base of everything above.
2. **Restack the orphaned chain onto `main`** using plan §8.4's documented procedure, which exists for
   exactly this situation. The deleted base was recovered as `refs/pull/2/head` — GitHub retains a
   merged PR's head commit after branch deletion — giving the fork point `52dbe00` needed for
   `git rebase --onto origin/main 52dbe00`.
3. **Rebuild `aw/w0-integration` rather than rebase it.** It is a merge commit, and replaying merges
   through a rebase is where this kind of recovery usually goes wrong.
4. **Every wave prompt from Wave 1 onward states the prohibition explicitly** — never `gh pr merge`,
   never `--delete-branch`, never delete a remote branch, never `git push --force`. This was
   previously implicit in the plan. It stays, not because a wave agent broke it, but because the
   consequences of one doing so are now measured rather than theoretical.
5. **Coordination with peer sessions is its own problem**, addressed in
   [ADR-0014](0014-concurrent-sessions-on-one-repository.md).
6. **Publish a decision where the people bound by it can read it.** ADR-0001 was authored on an
   unmerged branch, so the only merge policy visible on `main` was plan §8.6, which says to merge.
   A rule nobody else can see is not a rule. Wave manifests and ADRs that bind other writers are
   announced to peer sessions directly, because there is no shared trunk to publish them on.

## Alternatives considered

- **Revert both merges and restore the branches.** Rejected: `main` would carry two revert commits
  recording a coordination failure rather than a technical one, and the restack still has to happen.
- **Abandon the chain and re-apply the tip content as one fresh branch off `main`.** Rejected: it
  discards the per-task PR history that four rounds of verification are attached to, which is the
  audit trail the honesty gates depend on.
- **Treat the merges as ratifying a change of policy.** Rejected: ADR-0001 stands until the Owner
  changes it, and another session's instruction is not this session's instruction.

## Consequences

- `main` now carries working code, which ADR-0001 said it would not. ADR-0001's rule applies from
  here; its statement that "`main` never carries working code" is inaccurate for those two commits.
- Commit hashes below the integration branch changed. Any pre-restack SHA cited in a PR body or a
  research note is stale.
- PR #6 could not be reopened — GitHub refuses when the base branch is gone — so the work is now
  PR #11 against `main`, with #6 annotated to point at it.
- The recovery depended on `refs/pull/<n>/head` still resolving. Had the repository been configured
  to purge those, the chain would have had to be rebuilt by content rather than by history.
- **The wider lesson is the attribution error, not the merge.** This session assumed it was the only
  writer because it had not checked. Every later wave now re-fetches and reconciles before it starts.
