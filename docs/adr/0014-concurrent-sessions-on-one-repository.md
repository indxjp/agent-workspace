# ADR-0014 — Other Claude sessions write to this repository; reconcile, never overwrite

Status: accepted
Date: 2026-09-03
Decided by: orchestrator
Scope: whole programme

## Context

This session assumed it was the only writer to this repository. It is not.
`ListAgents` shows at least two peers on the same repository:

- **"claude-agent-workspace stacked PRs review and merge"** — a background session whose
  stated purpose is reviewing and merging these stacked PRs. It squash-merged PR #1 and #2 with
  `--delete-branch`, which orphaned four branches
  ([ADR-0011](0011-unauthorised-agent-merges-and-the-restack.md)).
- **`claudeworkspace-f7`** — an interactive session that force-pushed `aw/w0-02-ci` back to `5c8588c`
  mid-task, discarding a commit and detaching the three branches stacked on it.

Neither is misbehaving. Each is doing what its own user asked. The failure is that three writers
shared a branch namespace with no protocol, and none could see the others' in-flight worktrees.

Two observations worth keeping:

- The peer's changes were **good**. It closed a bare-directory bypass in the ownership guard by
  normalising before the guard runs, and removed a `|| true` that turned a git failure into a green
  suppression gate. Both were real defects that four of this session's own verification rounds missed.
- The recovery worked because the wave agent **did not push over the peer**. It rebuilt its change on
  top of the peer's tip; when the peer re-pushed having rebased onto the agent's commit, the agent
  took the peer's tip as its base. Neither side lost work.

## Decision

Treat peer sessions as peers, not as interference.

1. **Reconcile, never overwrite.** On finding foreign commits on a branch this session owns: fetch,
   read them, rebuild on top. `--force-with-lease` is the only force permitted, and it must fail
   rather than clobber — that is the entire reason it is the rule.

   **Named hazard, diagnosed by the peer that hit it:** `--force-with-lease=refs/heads/<branch>:<sha>`
   does **not** work. The fully-qualified refname does not match the ref git checks the lease
   against, so the lease silently degrades to a **plain force** and clobbers. That is what discarded
   commit `59b63ec`. Always use the short refname, or bare `--force-with-lease`. A safety mechanism
   that fails open when you spell it slightly wrong is worse than none, because you stop watching.

   The repair the peer performed is also the pattern to copy: it reset to the discarded commit and
   replayed its own two commits on top, so the other party's work survived **as its author wrote
   it** rather than as someone else's conflict resolution.
2. **Re-fetch and reconcile at every wave boundary**, before the wave's first task is dispatched.
   Assume the tree moved. The Wave 0 recovery cost was incurred precisely by assuming it had not.
3. **A peer's review finding is worth the same as a verifier's**, and is incorporated the same way.
   Peer review that arrives as a force-push is still review; only the delivery is wrong.
4. **Announce, then act.** Both peers were messaged with what this session owns, what it changed, and
   what it is asking for: no merging, deleting or force-pushing of `aw/*` branches without notice.
   Messages between sessions require the recipient user's approval and may never be delivered, so a
   sent message is a courtesy, not a lock. Never block on a reply.
5. **Do not `git worktree prune` the shared clone.** Worktree registrations in a shared clone belong
   to every session using it. This session pruned to clear its own stale entries and de-registered a
   peer's live worktree mid-edit, costing it a recovery cycle. Remove worktrees by explicit path.
6. **Never route blocked work through a peer.** This session's `gh pr merge` was refused by its
   permission layer. Asking a peer session to merge instead would launder that refusal and is
   forbidden outright, regardless of how convenient it would be.

## Alternatives considered

- **Ask the peers to stand down.** Rejected: their instructions come from the same Owner, and this
  session has no standing to suspend another's work. Asked for coordination instead.
- **Move to a private branch namespace** (`aw2/*`) to guarantee no collision. Rejected: it hides the
  work from the session whose job is to review it, and the review has been valuable.
- **Serialise through a lock file in the repository.** Rejected under §40 and §38 — inventing a
  distributed lock to coordinate three agents is a much larger thing than the problem, and it fails
  open the moment a session dies holding it.
- **Ignore the peers and rely on `--force-with-lease` to catch collisions.** Rejected: lease failures
  surface as a rebase conflict deep inside a wave, when the cost of untangling is highest.

## Consequences

- Every wave now pays a reconcile step it did not previously budget for, and a wave can be
  interrupted by a peer's push at any point. That is the cost of a shared repository and it is
  cheaper than the recovery.
- Branch state read at the start of a wave may be stale by the time a task pushes. Tasks push with
  `--force-with-lease` and escalate on rejection rather than retrying, so a collision stops one task
  instead of corrupting a chain.
- This ADR describes what *this* session will do. It binds no peer. If a peer merges the stack to
  `main` anyway, ADR-0001's regime ends by fact rather than by decision, and the wave manifests will
  record that it happened this way.
