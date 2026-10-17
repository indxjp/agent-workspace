# ADR-0040 — A test-run artefact is not committed: the harness self-test result is ignored, not tracked

Status: accepted
Date: 2026-09-14
Decided by: Owner, after the same file blocked two consecutive Wave 9 pull requests
Scope: `tests/e2e/results/harness-selftest.json`; `tests/e2e/results/.gitignore`

## Context

`tests/e2e/run-harness-selftest.mjs` writes `tests/e2e/results/harness-selftest.json` with a fresh
`generatedAt` timestamp on every run, and `tests/e2e/flow.test.ts` spawns that script twice, so every
`pnpm test` rewrites the file. The sibling `flow.json` was ignored from the start; the self-test result
was committed by accident in `5b2dc6c` and has since moved on three unrelated commits.

The cost became visible during the Wave 9 close-out. `scripts/check-file-ownership.mjs --pr` requires
the diff to be a subset of the PR's `Owns globs:` line, and no task owns a run artefact — so a
contributor who runs `pnpm test` before committing ships a diff that fails the File-ownership gate. The
indx-dev auto run on #182 (PR #191) fixed the finding twice and both times its own verification run
re-dirtied the file before the commit, because the verify command runs after the fix. Nothing reads
the committed copy: CI and `live-e2e.yml` read only `flow.json`.

## Decision

The file is untracked and `tests/e2e/results/.gitignore` lists it next to `flow.json`. The script is
unchanged — it still writes the file, which is the point of a self-test that records its result — but
the result stays in the working tree.

## Consequences

- `pnpm test` no longer dirties the tree; the File-ownership gate sees only what a task changed.
- Anyone who wants the last self-test result reads it locally or from the run log; it was never an
  evidence artefact and no ledger cites it.
- No test, gate or script changes; `git ls-files tests/e2e/results` lists only the `.gitignore`.
