# ADR-0039 — A gate whose verdict depends on directories only one clone has is not a gate

Status: accepted
Date: 2026-09-05
Decided by: orchestrator, after `pnpm lint` died on the sub-wave 2b-1 integration branch while every PR in it was green
Scope: `eslint.config.mjs`; any future repository-wide check that walks the working tree rather than the tracked tree

## Context

The sub-wave 2b-1 integration branch was assembled and its gates run before landing. `pnpm build`,
`pnpm typecheck`, `pnpm format:check`, the ownership self-test and the wave-ownership checker all
passed. `pnpm lint` aborted:

```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
```

It aborted again at `--max-old-space-size=8192`, after 151 seconds and 8.1 GB.

The cause is not in any merged track. A wave runs its parallel tasks in git worktrees under
`.claude/worktrees/`, and **each worktree is a full checkout of this repository**. At the time this
was found the tree held 54 of them. `eslint.config.mjs` ignored `**/node_modules/**` and
`**/dist/**`, which excludes the bulky parts, but every worktree's own `apps/` and `packages/`
sources were still matched — and this repository lints **type-aware**
(`recommendedTypeChecked`, chosen deliberately in `docs/adr/W0-INF-01-type-aware-linting.md`), so
each copy costs a whole TypeScript program.

The part that matters is not the memory. It is this:

**Every pull request in the sub-wave was green on the same commits.** CI checks out a clean tree in
which `.claude/worktrees/` does not exist, so `eslint .` there sees one copy of the repository and
finishes in seconds. The identical command, on the identical commit, aborted on the machine actually
running the wave.

So for as long as this held, `pnpm lint` reported two different verdicts for one tree, and which one
you got depended on how many other tasks happened to be in flight beside you. A developer running it
locally to check their work before pushing would see a crash they could not attribute, would find
nothing wrong with their diff, and would reasonably conclude the gate was flaky and stop trusting
it. That is worse than a gate that simply fails.

## Decision

**`eslint.config.mjs` ignores `.claude/worktrees/**`,** with the reasoning written next to the entry
rather than only here.

And the general rule the incident produces:

**A repository-wide check must decide from the tracked tree, not from whatever the working directory
happens to contain.** Where a check does walk the filesystem, everything that is not source must be
excluded *by the check's own configuration* — `.gitignore` does not constrain ESLint, Prettier,
Vitest, or any other tool that globs. Every such tool needs the exclusion stated separately, and a
tool that has not been given it will silently disagree with CI.

The three checks that already obey this are the ones that ask git: `check-file-ownership.mjs` and
`check-wave-ownership.mjs` both derive their file sets from the tracked tree, and the ADR index
generator selects `ls docs/adr/*.md`, a fixed directory. None of them noticed the 54 worktrees.

## Consequences

- `pnpm lint` now gives the same verdict locally and in CI, which is the only property that makes it
  worth running locally at all.
- The exclusion is invisible in CI — it changes nothing there — so nothing in CI will ever tell us
  if it is removed. That is stated here rather than implied (ADR-0031), and it is the cost of the
  fix: the entry is load-bearing only on the machine running a wave, which is exactly the machine
  with no gate watching it.
- `pnpm format:check` was checked and is unaffected: its globs are explicit path lists
  (`apps/**`, `packages/**`, `scripts/**`, `*.{json,mjs,ts}` and two named files), so it never
  descends into `.claude/`. Vitest's projects are similarly rooted at the workspace packages. Both
  were verified rather than assumed.
- This is a second instance of one shape. `.gitignore` gained `.claude/worktrees/` earlier the same
  day, for the neighbouring hazard — a `git add -A` sweeping a second copy of the whole tree into a
  commit. The directory is inside the repository because that is where `git worktree add` is
  pointed, and every tool that walks the tree has to be told about it separately.

## Alternatives rejected

**Put the worktrees outside the repository.** Would remove the class rather than patch it, and is
the better answer in the abstract. Rejected for now because the worktree path is written into the
dispatch protocol every running agent has already read, and changing it mid-wave would strand
worktrees that other sessions hold open — `git worktree prune` is forbidden here for exactly that
reason (ADR-0014). Worth revisiting between waves.

**Raise the heap and move on.** It failed at 8 GB with 54 worktrees; the number of worktrees grows
with every wave. This is not a limit to raise, it is a set to bound.

**Have CI run the lint from a dirty tree so the two agree.** Makes CI slower, less deterministic and
dependent on state it does not control, to fix the wrong side of the disagreement.

## Related

- `docs/adr/W0-INF-01-type-aware-linting.md` — why linting is type-aware, which is what makes each
  extra copy expensive.
- [ADR-0014](0014-concurrent-sessions-on-one-repository.md) — why worktrees are not pruned here.
- [ADR-0019](0019-repo-wide-gates-belong-to-the-integration-level.md) — repository-wide gates belong
  to the integration level, which is where this was found and where it is fixed.
- [ADR-0031](0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md) — state a
  gate's limits; never imply completeness.
