# ADR-0130 — `install-live` runs the docs' commands and the ten use cases from npm, with the real model, on three operating systems

Status: accepted
Date: 2026-10-09
Decided by: the issue #881 plan (VC-3), reviewed in the pull request
Scope: `.github/workflows/install-live.yml`, `tests/docs-claims/` (`run.mjs`, `host.mjs`, `use-cases.mjs`, `scan-secrets.mjs`, `install-live-report.mjs`), `tests/journey/run.mjs` (`watchDev`), `docs/release/README.md`

## Context

The docs claims runner (VC-2, `tests/docs-claims/run.mjs`) proves every `claim="run"` block in a
Docker clean machine against a Verdaccio that serves this checkout, and the journey proves the
release against the real registry only when a person runs it by hand. Neither shows that what a
user gets from registry.npmjs.org works on the machines users have: macOS and Windows, in
PowerShell as well as a POSIX shell, with the real model.

## Decision

- **One workflow, `install-live`, not a required check.** It is triggered by the end of a
  `Publish packages` run, nightly and by `workflow_dispatch`. It is not in `ci-success.needs`: a
  model or registry outage must not block a merge. It has no `pull_request` trigger, because it
  holds the live model key and a pull request's code would run with it; a change to the workflow is
  tried with `workflow_dispatch` from its branch.
- **The published `latest`, no Verdaccio.** The `resolve` job reads `dist-tags.latest` of
  `@indx-workspace/create`, waits up to ten minutes for the version a publish run names (and for all
  seven packages), and refuses a version that is not `latest`: the docs describe `latest`. It logs
  the registry URL. The harness comes from the tag `packages-v<version>` when that tag holds it;
  an older tag predates this ADR, so the harness of the workflow's own commit tests those packages
  and a `::notice` says so.
- **The same runner, a second machine.** `run.mjs` now runs against a `Machine` with two
  implementations: the journey container (ubuntu) and `host.mjs`, the runner itself
  (`--machine host --registry <url>`), in `sh`, `bash` or `pwsh` (`--shell`). The host machine gives
  a run its own home directory, npm cache and global prefix and leaves nothing outside the work
  directory. A block is for one shell (`shell="posix|powershell"` in the fence, `data-shell` on the
  LP); a block for another shell reads `n/a (<shell> only)`. The lanes are ubuntu (container), macOS
  (`sh`), Windows (`pwsh`) and Windows (`bash`, Git Bash).
- **Ten use cases.** `use-cases.mjs` copies the ten `tests/gallery` projects, starts each project's
  MCP servers from the `#   ...` lines of its `agent-workspace.yaml`, then runs `aw dev` until
  ready, `aw check`, `aw chat` with the first prompt of its eval and `aw eval`, against the
  published `aw` and `sdk`. The `aw eval` row passes on exit 0.
- **A missing key is `skipped`, never a pass.** `--model live` without `ANTHROPIC_API_KEY` no longer
  throws: every row from a page's first `npm run dev` on reads `skipped`, with the reason, and
  `exitCodeOf` returns 1 for a `FAIL` or a `skipped` row. `n/a` does not fail a run.
- **The key is a secret of two steps and of no file.** It is read from the repository secret in the
  `env:` of the two steps that run the harness, never echoed, and the workflow never traces. The
  harness reads it once, removes it from its own environment, hands it only to the commands that
  need the model, and scrubs it from every log. Before any upload `scan-secrets.mjs` fails the job if `sk-ant-` followed
  by key characters is in the summary, results or logs, and the upload runs only if that scan
  passed. The docs placeholder `sk-ant-...` has no key characters and passes.
- **Results are kept and reported.** Each lane uploads `summary.md`, `results.json` and `logs/` for
  90 days. The `report` job (the only one with `issues: write`, and with no key) writes one table to
  the job summary and the `install-live-summary` artifact. A `FAIL` row, a missing lane or a failed
  job opens an issue labelled `install-live` or comments on the open one; a run with nothing failed
  or skipped closes it. A run with only skipped rows files nothing; FAIL rows still file,
  deduplicated by failure set: the body carries `<!-- install-live-digest:<sha256> -->` of the
  sorted FAIL lines, and the open issue is not commented on again while its latest body or comment
  holds the same digest. A skipped-only run is a configuration gap, named in the table, and red.
- **Known failures stay visible.** A macOS or Windows failure that is a product bug is a `FAIL`
  row, a separate bug issue with the log, and an entry `{ lane, where, issue }` in
  `tests/docs-claims/install-live-known.json`. Its row reads `known failure (#N)` in the summary
  and keeps the run red, but is left out of the digest; it is never skipped. An entry whose row
  passes reads `stale known failure`, so the list cannot rot.

## Alternatives

- **A second runner for macOS and Windows.** It would drift from the claims the docs make; the
  runner's extractor and rows are the contract.
- **GitHub environment protection for the key.** An environment adds a reviewer gate on a nightly
  job; the repository secret is passed to two steps only.
- **A `pull_request` trigger.** It would give pull-request code the live key.
- **Close the issue on a skipped-only run.** A gap is not a recovery.
- **Windows signal handling.** Windows has no SIGINT for a process tree, so the host machine kills
  the tree and does not check `aw dev`'s exit code there; POSIX hosts check it.

## Consequences

The lane needs the repository secret `ANTHROPIC_API_KEY`, which is not configured today; until it
is, every run is red and reads `skipped`. Cost is one run of the real model per use case per
night. The quotation use case's ERP is unreachable from a runner and cannot be redirected, so its
`aw eval` may honestly fail; contract-review's playbook upload is not done. A run against a release
older than this ADR tests its packages with newer docs and harness, which can fail for version
lag rather than a defect in the harness.
