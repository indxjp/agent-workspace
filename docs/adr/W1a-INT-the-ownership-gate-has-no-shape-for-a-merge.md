# W1a-INT — The ownership gate cannot pass an integration branch, and the honest answer is to say so

Status: accepted
Date: 2026-09-03
Decided by: W1a integrator
Scope: `scripts/check-file-ownership.mjs --pr` as it applies to a wave integration PR; binding on
how a wave integrator writes its Ownership section

## Context

[ADR-0018](0018-the-declared-owns-line-is-the-ownership-boundary.md) makes the PR body's
`Owns globs:` line the effective ownership boundary, subject to three mechanical conditions, the
second of which is *"the CI ownership gate passes against it — every changed file is inside it."*

A wave integration PR cannot satisfy that condition. The gate diffs `merge-base(base, head)...head`,
and an integration branch's whole purpose is to carry every sibling's files across that diff. Run
locally against this branch and the Ownership section this PR actually declares:

```
$ printf '## Ownership\nOwns globs: `<Wave 1a manifest>`, `docs/adr/W1a-INT-*.md`, `docs/adr/0017-*.md`, `docs/adr/0018-*.md`, `docs/adr/README.md`\nFiles touched outside Owns: none\n' \
    | node scripts/check-file-ownership.mjs --pr --base origin/aw/w1-02b-deps --head HEAD
Declared Owns globs: <Wave 1a manifest>, docs/adr/W1a-INT-*.md, docs/adr/0017-*.md, docs/adr/0018-*.md, docs/adr/README.md
Changed files (83):
…
FAIL: 80 file(s) changed outside the declared Owns globs:
```

83 changed files, 3 of them written here. The other 80 were written by W1-RN-01, W1-RN-02, W1-CP-04,
W1-CP-05 and W1-INF-02, each inside its own declared globs, and each already passed by this same gate
on its own PR.

Wave 0's integration PR (#9) passed the gate, which is why this was not discovered then. It merged
branches whose files happened to fall entirely under `docs/**` plus five explicitly granted paths,
so a declaration of that shape covered them. Wave 1a's tracks span `apps/**`, `packages/**`,
`tests/**`, `.github/**` and `docs/**` — the union is the repository, and the gate refuses a
declaration of that reach on purpose:

> `the "Owns globs:" line declares …, which together claim the repository rather than one task's
> part of it … That is not a declaration, it is a disabled gate`

That refusal is right. There is no spelling of an `Owns` line that both passes this gate and means
anything on an integration branch.

## Decision

1. **The integration PR declares only the files the integrator wrote** —
   the Wave 1a manifest, `docs/adr/W1a-INT-*.md`, `docs/adr/0017-*.md`, `docs/adr/0018-*.md`,
   `docs/adr/README.md` — and **accepts the ownership gate's FAIL**, with the transcript above in the
   PR body and the reason next to it.
2. **The claim ADR-0018 condition 2 exists to protect is asserted a different way, and is asserted.**
   The property that matters on an integration branch is not "every changed file is mine"; it is
   **"every changed file is inside the declared globs of the task whose merge commit introduced
   it"**. That was checked here, per merged branch, before the merge:

   ```
   $ for b in aw/w1-04-runner-server aw/w1-05-run-api aw/w1-06-agent-crud aw/w1-07-auth aw/w1-08-ci-database; do
       git diff --name-only $(git merge-base HEAD origin/$b) origin/$b; done
   ```

   The five file lists are pairwise disjoint except for `docs/adr/README.md` (generated; five-way
   conflict, resolved five times by re-running the generator) and `pnpm-lock.yaml` (generated;
   [ADR-0017](0017-manifests-belong-to-their-package-the-lockfile-is-generated.md) rule 2, declared
   by W1-RN-01 and W1-DEP-01). **No hand-written file was claimed by two tasks.** That is the §2.3
   property, and it held.
3. **The gap is reported, not patched.** `scripts/check-file-ownership.mjs` is W0-INF-02's file and
   nothing about it is edited here.

## Alternatives considered

- **Declare `docs/**`, `apps/**`, `packages/**`, `tests/**`, `.github/**`.** Rejected: the gate
  refuses it by name, and it should — an integrator who declares the repository has declared nothing.
- **Reparent the PR onto each merged tip in turn so each diff is small.** Rejected: that is five PRs
  that are not an integration, and the question this branch exists to answer — *do the four tracks
  compose?* — is not asked by any of them.
- **Add an `--integration` mode to the checker that walks merge parents.** This is the right fix and
  it is a real one: for a merge commit, the gate could attribute each file to the parent that
  introduced it and check it against that branch's PR body. It is rejected **here** only because
  `scripts/check-file-ownership.mjs` belongs to W0-INF-02, not because it is wrong. Carried into W1b
  as a request.
- **Say nothing and let the red check speak.** Rejected: a failing gate with no explanation is
  indistinguishable from a task that wrote outside its bounds, which is the accusation this gate
  exists to make.

## Consequences

- The Wave 1a integration PR carries a **failing ownership check that is expected and explained**.
  A reviewer must read the Ownership section to tell it apart from a real violation — which is the
  cost, and it is the same cost ADR-0018 already imposes for a widened glob.
- **This normalises exactly one red check, and only for an integration PR.** Any other PR failing the
  ownership gate is still a violation. If a later wave's integrator cites this record for a
  non-integration branch, the citation is wrong.
- Until the checker learns about merge commits, the §2.3 disjointness property on an integration
  branch is verified **by the integrator running the per-branch diff above**, and its evidence is the
  paste in the manifest — a human step where there was a mechanical one, which is a downgrade and is
  named as one.
