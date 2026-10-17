# ADR-0050 — The ownership gate cannot see a sibling, so wave-level disjointness is checked by hand before a wave merges

Status: accepted
Date: 2026-09-12
Decided by: the Wave 9 orchestrator
Scope: Wave 9 sibling PRs and `scripts/check-file-ownership.mjs --pr`

## Context

The PR ownership gate proves only that one PR's changed files are a subset of that PR's declared
globs. It does not read sibling PRs. `scripts/check-wave-ownership.mjs` compares the plan's globs,
not the changed-file sets at the PR heads. Two individually valid PRs can therefore overlap without
either committed check seeing the overlap.

## Decision

Before sibling PRs merge, compute every pairwise intersection from the PRs' actual changed-file
sets. Ignore only `docs/adr/README.md`, because that index is generated and is regenerated after
restacking. Any other path is an ownership violation: amend the plan and move the change back to one
owner rather than resolving the overlap during restack. A restack must stop on every non-index
conflict. This remains a manual check; the proposed sibling-aware committed gate was not built.

## What was checked in Wave 9, and whether it fired

The saved command output records two checks for each of W9.5 and W9.6:

```text
W9.5 check 1, before merge, origin/main=372fc54:
all ten task-pair intersections were (empty)

W9.5 check 2, final PR heads #159–#163:
all ten PR-pair intersections were (empty)
# never fired

W9.6 check 1, PR heads #175=55971e4, #173=f47c43a, #172=9373aab:
each pair intersected only at docs/adr/README.md
intersection modulo docs/adr/README.md: (empty)

W9.6 check 2, PR heads #175=55971e4, #173=890f154, #172=a28b8b2:
each pair intersected only at docs/adr/README.md
intersection modulo docs/adr/README.md: (empty)
```

W9.1–W9.4 have no saved branch-diff intersection output. Their plan-level ownership check passed,
but this record does not promote that different proposition into evidence that the manual PR-head
check ran.

W9.5a contained only W9-SEC-168, so it had no sibling pair to compare. W9.7 final disjointness was
not measured: development stopped before #124 and #122 had implementation PR heads. The plan-level
W9.7 glob check is not a substitute for an actual-diff check that cannot yet be performed.

## Alternatives considered

- Trust the plan-level checker alone. Rejected because it checks planned globs, not PR-head diffs.
- Serialise every task. Rejected because it removes the parallelism the ownership rule exists to
  make safe.
- Add sibling exclusions to each PR body. Rejected because one PR cannot keep its siblings' bodies
  authoritative or current.

## Consequences

The Wave 9 manifest can distinguish observed PR-head disjointness from plan-only evidence. A future
wave remains dependent on a manual step until a sibling-aware check is deliberately designed.
