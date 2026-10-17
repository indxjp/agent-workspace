# W1-INT-02 — The ownership gate learns about merges: attribute each file to the parent that introduced it

Status: accepted
Date: 2026-09-03
Decided by: W1-INT-02 (Wave 1 invariants)
Scope: `scripts/check-file-ownership.mjs`; supersedes the "no change is made to the checker" clause of
[W0-INT-01-integration-pr-declares-the-union](W0-INT-01-integration-pr-declares-the-union.md) and
closes the request in
[W1a-INT-the-ownership-gate-has-no-shape-for-a-merge](W1a-INT-the-ownership-gate-has-no-shape-for-a-merge.md)

## Context

`--pr` diffs `merge-base(base, head)...head` and requires every changed file to be inside one
`Owns globs:` line. A wave integration branch cannot satisfy that: its purpose is to carry the files
five other tasks wrote. Wave 1a measured it — 87 changed files against `origin/aw/w1-02b-deps`, seven
of them the integrator's — and the checker's whole-repository reach guard correctly refuses the only
declaration wide enough to cover the rest. W1a's integrator recorded the failure, declared only its
own files, and shipped a knowingly red check.

Two records had already named the fix and declined to implement it, both for ownership reasons rather
than design ones: W0-INT-01 ("a real change to the checker's semantics … an integrator editing the
gate it is being judged by is the conflict of interest §2.3 exists to prevent") and W1a-INT ("this is
the right fix … rejected **here** only because `scripts/check-file-ownership.mjs` belongs to
W0-INF-02"). W0-INF-02's branch `aw/w0-02-ci` is frozen far below this one — `git rev-list --count
--first-parent 5f80562..origin/aw/w1-11-compose` is 59, where `5f80562` is the commit that added the
checker — and [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) governs, so
W1-INT-02 declares the file with that reason and implements it. W1-INT-02 is not itself an
integration branch, so it is not editing the gate that judges it: this PR is checked by `--pr`, as
any task branch is, and its transcript is in the Ownership section.

## Decision

**A new mode, `--integration`, whose rule is "every changed file is inside the declared globs of the
branch whose merge introduced it, or inside the integrator's own globs" — and whose fall-through
FAILS.**

1. **Attribution comes from the commit graph, never from the body.** The merges on
   `base..head`'s first-parent path are enumerated; for each merge, each parent after the first is a
   merged branch, and the files it introduced are `diff(merge-base(firstParent, parent), parent)`.
   `--first-parent` is deliberate: a merge that happened *inside* one of the merged branches is that
   branch's own history and its files are already attributed to it.
2. **The per-branch declaration comes from the body**, as one `Merged <ref>: <globs>` line per merged
   branch inside the same `## Ownership` section, repeating the globs that branch declared on its own
   PR. That is the [ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) interface: a
   declaration lives in a PR body, and here it is being carried forward rather than invented.
3. **Body and graph must agree, in both directions.** A merged parent with no declaration fails,
   naming its SHA and the merge that brought it. A declared ref that no merge introduced fails too —
   the two disagreeing about what was merged is a fact about the PR, not a spare line.
4. **Each `Merged` line is put through the same whole-repository reach guard as an ordinary `Owns`
   line.** `Merged aw/x: **` gates nothing and is refused, exactly as `Owns globs: **` is.
5. **A file no parent introduced must be inside the integrator's own `Owns globs:`, and a file some
   parent introduced must be inside that parent's globs.** Anything else is a violation, and the two
   cases are reported with different reasons because they call for different repairs: the first is an
   integrator edit that was not declared, the second is a branch that wrote outside its own
   declaration.
6. **A file introduced by more than one parent needs only one of them to vouch for it.**
   `docs/adr/README.md` and `pnpm-lock.yaml` are generated and arrive from several branches
   ([ADR-0017](0017-manifests-belong-to-their-package-the-lockfile-is-generated.md) rules 2 and 3);
   requiring all of them would fail on the one case the programme has already ruled on.
7. **The mode is chosen by an explicit flag, never by inspecting the head commit.** "Does this commit
   have two parents?" as the gate's own off switch is the alternative W0-INT-01 rejected, and a merge
   commit is trivial to manufacture. A branch with no merge on its first-parent path is told to use
   `--pr`.

## Alternatives considered

- **Exempt integration PRs.** Rejected by W0-INT-01 and still rejected: it removes the gate from the
  PR that carries the most files.
- **Derive each branch's globs from its own PR body over the network.** Rejected: the checker has no
  dependencies and no network, `--self-test` is its only coverage, and a gate that needs GitHub to be
  reachable is a gate that fails for reasons unrelated to ownership. The body is where a declaration
  lives; transcribing it is the cost, and a transcription that is too narrow fails closed.
- **Attribute mechanically and check nothing else** — i.e. pass any file some parent introduced,
  without a per-branch declaration. Rejected: that is "not mine, so probably fine", and it would have
  passed a Wave 1a branch that wrote outside its own globs. The whole point of the property W1a-INT
  wrote down is the *inside the declared globs of* half.

## Consequences

- **A wave integration PR can now pass the ownership gate**, and the check means the thing W1a-INT
  said it should mean. Run against the real Wave 1a integration branch — the PR that could not pass —
  it reports every one of the 87 changed files accounted for. The transcript is on W1-INT-02's PR,
  together with four negative controls: an undeclared merged parent, a branch whose globs do not cover
  what it brought in, an integrator file nothing accounts for, and `--integration` on a branch with no
  merge.
- **`.github/workflows/ci.yml`'s "File-ownership gate" step still runs `--pr` on every pull request,
  and has no way to select the new mode**, so an integration PR's CI is still red until someone who
  owns that workflow teaches the step to choose. That file is outside W1-INT-02's `Owns`
  line; the gap is declared on the PR rather than fixed by widening ownership into CI configuration.
  Until then `--integration` is run by the integrator and its output pasted, which is what W1a-INT
  already required of the per-branch diff — with the difference that the check is now mechanical.
- **The integration PR body grows a line per merged branch.** W0-INT-01 predicted that "by Wave 5 the
  Ownership line is long enough that nobody reads it"; this replaces one unreadable union with one
  line per branch that a machine reads. It is still hand-assembled, and a *too wide* transcription is
  still caught only by a human — the same residual W0-INT-01 named, now bounded to one branch at a
  time.
- **`--help` no longer truncates.** Its usage text was sliced by a hardcoded line number, which
  silently cut the text mid-sentence when this mode was documented; it is now found by the landmark
  that ends the header block, and refuses to print rather than guess if that landmark is gone.
