# ADR-0009 — `pnpm-lock.yaml` is owned by the wave's first task

Status: accepted
Date: 2026-09-03
Decided by: orchestrator, ratifying W0-INF-01's declared deviation
Scope: whole programme

## Context

Plan §2.3 names package manifests and `pnpm-lock.yaml` "the classic offender" for ownership
collisions, and rules that dependency additions for a whole wave are batched into that wave's
**first** task. W0-INF-01's `Owns:` globs did not list the lockfile, yet the file is the direct
output of the first command of its own acceptance line (`pnpm install`), did not exist on `main`, and
is what makes `pnpm install --frozen-lockfile` possible for W0-INF-02's CI.

The agent committed it, declared it explicitly in a dedicated Ownership section, and offered to drop
it. Two independent verifiers assessed it as nominal-only and the sole file outside the globs.

## Decision

`pnpm-lock.yaml` is implicitly owned by whichever task is first in a wave's stack, as §2.3 already
intends for dependency batching. A later task in the same wave that discovers it needs a new
dependency **escalates**; it does not edit the lockfile in parallel.

The declaration must still appear in the PR body's Ownership section. An **undeclared** lockfile
change remains an ownership violation.

## Alternatives considered

- **Gitignore the lockfile.** Rejected: it defeats `--frozen-lockfile`, the only thing making CI
  installs reproducible, and spec §42's version-pinning discipline depends on it.
- **A dedicated "lockfile" task per wave.** Rejected as ceremony: it serialises every wave behind a
  task that does nothing but run `pnpm install`.

## Consequences

- The ownership checker keeps flagging the lockfile unless the first task declares it. That friction
  is intended: the flag is how a reviewer learns dependencies changed.
- Two tasks in different waves can still conflict on it across a restack. Because waves are frozen
  once closed ([ADR-0001](0001-no-merge-to-main-wave-integration-branches.md)), this surfaces as a
  rebase conflict on the integration branch, resolved by re-running `pnpm install`.
