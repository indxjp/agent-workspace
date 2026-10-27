# ADR-0149 — `main` requires a pull request and the CI success gate; PRs land by squash

Status: accepted — Supersedes [ADR-0001](0001-no-merge-to-main-wave-integration-branches.md), [ADR-0020](0020-the-stack-lands-on-main-by-merge-not-squash.md)
Date: 2026-10-18
Decided by: the Owner (ruleset applied 2026-10-18)
Scope: the default branch of this repository and every pull request into it

## Context

[ADR-0001](0001-no-merge-to-main-wave-integration-branches.md) kept `main` frozen and stacked waves on
integration branches. [ADR-0020](0020-the-stack-lands-on-main-by-merge-not-squash.md) reversed that and
landed the stack on `main` by real merges rather than squash, because a squash forces a restack of every
branch above it. Both were written for a deep PR stack and a human-run landing. Neither is how `main`
is advanced now: work arrives as independent PRs, each branched from `main`, and the stack that justified
merge commits no longer exists. Neither record said anything enforceable, so the policy lived in habit.
The Owner has now applied it as a repository ruleset, and this record makes the ruleset and the
conventions around it the single statement of merge policy.

## Decision

### Ruleset on the default branch

- **Required status checks**: `CI success` and `OSS export · dry run`. Non-strict: the branch need not
  be up to date with `main` before merging.
- **Deletion** of the default branch is blocked.
- **Non-fast-forward** updates (force push) are blocked.
- **Pull request required**, with **0 approvals**. Review is a practice, not a ruleset requirement.
- **Admin bypass** is `pull_request` mode only: an administrator may merge a PR past the rules, but may
  not push directly to `main`.

### Merge conventions

- **Squash merge.** One commit per PR on `main`; `git log --first-parent` and the plain log coincide.
  This replaces ADR-0020's real-merge rule, whose reason (restacking a deep stack) no longer applies.
- **Merge with `--match-head-commit <sha>`** (`gh pr merge --squash --match-head-commit <sha>`), so only
  the commit that was reviewed and went green can land.
- **Update a branch by merging `origin/main` into it with a merge commit.** Never rebase and never
  force-push a PR branch.
- **Delete the head branch after the PR is `MERGED`**, not before, and never a branch that is still a
  draft or open. Branch-deletion coordination per ADR-0014 still applies.
- **`CI success` is the single aggregate gate.** It depends on every other CI job; a new required job is
  added to its `needs`, not to the ruleset. The ruleset names only `CI success` and the OSS export dry run.

## Alternatives considered

- **Strict status checks (branch must be up to date).** Rejected: with many parallel PRs it forces a
  merge-and-wait loop on every landing for no added safety, since `CI success` runs on the PR merge ref.
- **Require approvals.** Rejected for now: the programme is run by one Owner plus agents; an approval
  count of 1 would be satisfied by the same person. The required checks are the gate.
- **Keep ADR-0020's real merges.** Rejected: independent single-commit-sized PRs give a noisier history
  under merge commits and gain nothing without a stack.
- **Allow admin direct pushes.** Rejected: it bypasses `CI success` and the export dry run.

## Consequences

- ADR-0001 and ADR-0020 are superseded; they stay as history and carry a pointer here.
- Nothing reaches `main` without a PR and a green `CI success` plus export dry run. A red gate on
  `main` can then only come from a check that passes on the PR but not after the merge, which non-strict
  checks permit; a red `main` is fixed forward by a PR.
- Renaming the `CI success` job or the export dry-run job silently un-requires it unless the ruleset is
  updated in the same change.

## How to verify

```
gh api repos/{owner}/{repo}/rules/branches/main
```

The response lists `deletion`, `non_fast_forward`, `pull_request` (with `required_approving_review_count` 0) and `required_status_checks` naming `CI success` and `OSS export · dry run`, with
`strict_required_status_checks_policy` false. The bypass mode is under the ruleset itself:
`gh api repos/{owner}/{repo}/rulesets/25291483`; `bypass_actors` carry
`bypass_mode: pull_request`.

## Rollback

Restore the ruleset to its state before this policy. Do not disable it: that would also drop the
earlier `OSS export · dry run` requirement. Save the JSON below as `before.json` and run:

```
gh api -X PUT repos/{owner}/{repo}/rulesets/25291483 --input before.json
```

```json
{
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "OSS export · dry run", "integration_id": 15368 }]
      }
    }
  ],
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }]
}
```

Then supersede this record with a new ADR.

## Amendment (2026-10-19): merges go through a merge queue

Decided by: the Owner (decision D6 of the engineering audit, #1356).

Non-strict checks let a PR that is green against an old `main` land on a newer one and turn `main`
red (Consequences above). `main` now uses GitHub's **merge queue**, so every merge is tested against
the latest `main` before it lands, without the merge-and-wait loop that strict checks would force.

- **Operational change.** A PR is not merged directly any more: it is added to the queue
  (`gh pr merge <n> --match-head-commit <sha>` queues it, or the "Merge when ready" button; the
  queue's own merge method, squash, applies). The queue builds a temporary `gh-readonly-queue/main/*` branch of the
  PR on top of `main` (or of the group ahead of it), runs the required checks there, and squash-merges
  only when they pass. Squash, `--match-head-commit`, merge-to-update and delete-after-`MERGED` all
  still hold; a PR the queue rejects goes back to its author with the failing run linked.
- **Every workflow that produces a required check runs on `merge_group`** (`types: [checks_requested]`):
  `ci.yml` (`CI success`) and `oss-export.yml` (`OSS export · dry run`). A required check whose workflow
  lacks the trigger never reports for a group, and the queue waits until its timeout.
  `scripts/check-workflows.mjs` fails a workflow that produces a required check without it.
- **What a group run checks.** Affected and path-scoped jobs compare with `merge_group.base_sha`
  (`DIFF_BASE` in `ci.yml`), not `origin/main`, because a stacked group is built on the group ahead of
  it, which is not on `main` yet. The content diff gates (no new suppressions, lint baseline,
  expand-only migrations, secret scan, osv-scanner as on a PR, coverage floors) run against that base.
  The PR-body gates (file ownership, PR size, changelog fragment) are skipped with a notice: a group
  has no PR body, the queue only accepts a PR whose own run passed them, and a group changes nothing
  in the PR's diff; the changelog gate would even misjudge a group, whose branch is never `release/*`.
  Group runs read the Nx remote cache but never write it, and never cancel each other. The OSS
  export's `publish` job runs only on a push or a dispatch, never for a group.
- **Ruleset.** The `merge_queue` rule is added to ruleset 25291483 after this change lands, never
  before (queued PRs would wait for checks that never start). `CI success` and `OSS export · dry run`
  stay the required checks, non-strict: the queue, not strictness, is what tests against the latest
  `main`.

Rollback: remove the `merge_queue` rule from the ruleset; the `merge_group` triggers are then inert.
