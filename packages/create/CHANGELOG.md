# Changelog — `@indx-workspace/create`

One heading per release, newest first. Released in lock-step with `@indx-workspace/cli`, with the
same version (ADR-0082).

## 0.6.9 — 2026-10-14

No changes to this package. Released alongside the install-live harness fix (#1128) so the gallery use cases are verified live against the published packages.

## 0.6.8 — 2026-10-14

No changes; released in lock-step with the other packages.

## 0.6.7 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.6 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.5 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.4 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.3 — 2026-10-12

No changes; released in lock-step with the other packages.

## 0.6.2 — 2026-10-12

No changes; released in lock-step with the other packages.

## 0.6.1 — 2026-10-11

0.6.0 was cut as platform images only and its packages were never published to npm, so its entries ship in 0.6.1.

### Changed

- `npm create @indx-workspace` on a Node below 24 prints one line (`Agent Workspace needs Node 24 or
  newer; you have vX. Install it from https://nodejs.org or with nvm install 24`) and exits 1
  before loading the generator or asking anything (UX-D, #760).
- The generator it runs now asks the project name, offers to install and start, and prints
  shell-aware next steps: see `@indx-workspace/cli` (UX-D, #760).

## 0.5.0 — 2026-10-06

Pins platform images 0.5.0 (`images-v0.5.0`, published before `packages-v0.5.0`).

### Changed

- New projects keep a `README.md` and carry the `support`, `copilot` and `automation` starters as
  real files (FH-09, tracker #687); the setup question count follows the applicable questions.

## 0.4.0 — 2026-10-05

Pins platform images 0.4.0 (`images-v0.4.0`, published before `packages-v0.4.0`).

### Changed

- `npm create @indx-workspace <directory>` no longer stops without a terminal (#708): with no TTY
  and no `-- --yes` it takes the recommended answers and prints one stderr line saying so. The
  0.3.0 refusal of piped stdin without `--cloud` no longer applies to the v2 project.
- Every setup question has a flag, passed after `--` (`npm create @indx-workspace dir -- --theme
  <theme> --agent <name>`); a flagged question is not asked, and `-- --help` lists the flags.
- The generated project includes `evals/<agent>.yaml` with a few cases, so `npx aw eval` has
  something to run (#711), and a `package.json` with npm's `allowScripts` (#722).

## 0.3.0 — 2026-10-04

Pins platform images 0.3.0 (`images-v0.3.0`, published before `packages-v0.3.0`).

### Changed

- `npm create @indx-workspace <directory>` now writes a v2 project by default (S1-16, #454): a
  `package.json` pinning `@indx-workspace/aw`, `embedded` and `sdk` at the release version,
  `agent-workspace.yaml`, `agents/` and `surfaces/`. Next: `cd <directory> && npm install && npm
run dev`. No `.env` and no secret is written; `aw dev` reads `ANTHROPIC_API_KEY` from its
  environment.
- Breaking for scripted use: piping answers on stdin without `--cloud` (`npm create
@indx-workspace dir < answers`) is now refused with a hint, because the v2 setup questions are
  asked on a terminal. Pass `-- --cloud local` to keep the Compose project that reads its answers
  from stdin, or `-- --yes` for the v2 project with the recommended answers.

### Added

- `-- --yes` writes the v2 project with the recommended setup answers, without asking.

## 0.2.1 — unreleased

### Fixed

- Setup no longer keeps a rejected provider key; re-running setup repairs a connection left by
  0.2.0 (#415). The setup wizard's credential fields no longer invite browser autofill (#416). Pins
  platform images 0.2.1.

### Upgrade note

Existing 0.2.0 projects: replace the image digests in `.env` (`WEB_IMAGE`, `GATEWAY_IMAGE`,
`RUNNER_IMAGE` and `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK`) with the 0.2.1 ones, or
generate a new project with `@indx-workspace/create@0.2.1` and move your data across. See "Picking
up patched images in an existing project" in the CLI README. Re-running the setup wizard with a
valid key then repairs a connection that a refused attempt left behind.

## 0.2.0 — unreleased

### Changed

- Generates with `@indx-workspace/cli` 0.2.0, the lock-step minor release with
  `@indx-workspace/contracts` 0.2.0 (issue #393). No change to the generator.

## 0.1.3 — unreleased

### Security

- Pins platform images 0.1.2, which patch the next/og remote code execution (GHSA-vcvr-r3jv-pc5j,
  next 16.3.6) and @grpc/grpc-js CVE-2026-101916. Projects generated with 0.1.0–0.1.2 should update
  their image pins (generate a new project with `@indx-workspace/create@0.1.3` and move your data,
  or replace the image digests in `.env` — see the CLI README).

## 0.1.2 — unreleased

### Fixed

- Generates with `@indx-workspace/cli` 0.1.2, whose `agent-workspace start` runs the runner in the
  Docker daemon's own socket group, explains a taken host port, and says how to sign in over plain
  http at a remote address (issue #389).

## 0.1.1 — unreleased

### Fixed

- Generates with `@indx-workspace/cli` 0.1.1, whose `local` project publishes its web port, starts
  the Docker runtime, and is named after its directory (issue #377).

## 0.1.0 — unreleased

### Added

- Published to npm as `@indx-workspace/create`, so `npm create @indx-workspace@latest <directory>`
  runs `@indx-workspace/cli`'s generator (issue #364).
