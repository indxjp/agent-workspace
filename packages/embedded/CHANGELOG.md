# Changelog — `@indx-workspace/embedded`

One heading per release, newest first. Released in lock-step with `@indx-workspace/contracts`, with
the same version (ADR-0082 D3).

## 0.6.12 — unreleased

### Changed

- The local runtime's database is PostgreSQL 18 (`embedded-postgres` 18.4). A data directory an
  earlier release created with PostgreSQL 17 cannot be opened by 18: `aw dev` now stops with
  `data_directory_version` and leaves the directory as it was, instead of failing with the server's
  own error. Move `.agent-workspace/postgres` aside to start empty, or carry the data over as
  "Upgrade the local database" in the `aw dev` docs describes.

## 0.6.11 — unreleased

No changes to this package. Released in lock-step with the 0.6.11 storage and Builder release.

## 0.6.10 — unreleased

### Security

- Next.js moves to 16.4.2, which fixes an unauthenticated remote code execution
  ([GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw)) and an App Router
  denial of service ([GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r)) in
  Next.js 16.0.0 to 16.4.0.

## 0.6.9 — 2026-10-14

No changes to this package. Released alongside the install-live harness fix (#1128) so the gallery use cases are verified live against the published packages.

## 0.6.8 — 2026-10-14

### Changed

- The engines' SDKs and the cloud SDKs (AWS, GCP, Kubernetes, Azure Key Vault) are optional peers instead of
  dependencies, and the bundle loads each only when a run or a profile needs it: the base install
  goes from 1248 MB to 550 MB. A project installs its engine's packages itself; `npm create` and
  `aw init` name them (#691, ADR-0139).
- The package carries the files of Next and React its production server reads, traced at build
  time, instead of depending on `next`, `react` and `react-dom`: `@next/swc-*` and `sharp` are no
  longer installed, and the base install goes from 550 MB to 255 MB (25,559 to 17,389 files)
  (#691, ADR-0140).
- A Claude run names an MCP connector's tools by the connector's key (`mcp__<connector-key>__<tool>`,
  falling back to `connector-<id>`), and the policy response labels `connector-<id>` rules with that
  key (#1109, #1119, #1121, #1125).

### Fixed

- An aborted run waits for the killed skill script to exit before it returns, so a stopped run no
  longer leaves the script running (#1120, #1123).

## 0.6.7 — 2026-10-13

### Changed

- The control plane records the time of each durable run event and serves it as an optional `at` on the run event stream, so `aw runs trace` can show where a run spent its time (#1115).

## 0.6.6 — 2026-10-13

### Changed

- The `run_skill_script` tool description lists each skill's scripts with a hint to read its SKILL.md first, and the `unusable_script` refusal lists the available scripts (#1110).

## 0.6.5 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.4 — 2026-10-13

### Fixed

- A fresh `npm install` of the published packages pulled `@earendil-works` 1.2.0 siblings of pi
  (pi declares them as `^1.0.2`), and `aw dev` crashed with "does not provide an export named
  `MCP_TYPESCRIPT_PREAMBLE`". The whole pi family is now pinned exactly at 1.0.2 in
  `@indx-workspace/embedded`, and a test fails if pi gains a
  sibling that is not pinned.

## 0.6.3 — 2026-10-12

No changes; released in lock-step with the other packages.

## 0.6.2 — 2026-10-12

No changes; released in lock-step with the other packages.

## 0.6.1 — 2026-10-11

0.6.0 was cut as platform images only and its packages were never published to npm, so its entries ship in 0.6.1.

### Fixed

- A `RUNTIME_DRIVER` of `sandbox-runtime` (set by an older project or env file) no longer hides the
  no-isolation warning (#818). The driver has no implementation, so the workspace says once that
  the session runs on `local` with no isolation, runs it there and prints the `local` warning.
- The local runtime no longer outlives a killed `aw dev` (#760): when a service never closes during
  a stop, the process now exits 1 after the stop grace instead of ignoring every signal and
  spinning at 30% CPU.

## 0.5.0 — 2026-10-06

### Fixed

- `startWorkspace` is annotated so that the build emits its declarations (#749).

## 0.4.0 — 2026-10-05

### Changed

- Dependency update (#675, part of #668): `@earendil-works/pi-coding-agent` 0.87.1 to 1.0.2, with
  `@anthropic-ai/sdk` pinned at 0.129.0. This clears the HIGH advisory tracked in #668.
- Two projects run `aw dev` side by side (#664). The gateway, runner and embedded PostgreSQL
  ports are no longer fixed: each unset `GATEWAY_PORT`, `RUNNER_PORT` and `AW_DATABASE_PORT`
  becomes its default (4000, 8080, 25432) plus the web port's distance from 3000, so a project on
  `environments.local.port: 3070` uses 4070, 8150 and 25502. A derived port outside 1024-49151
  keeps its default; a set variable still wins.
- `aw dev` reports every busy port at once (#660). Before starting anything, the local runtime
  checks the web, gateway, runner and embedded PostgreSQL ports and fails with one message that
  names each port that cannot be bound, its role, and the setting that moves it
  (`environments.local.port` in `agent-workspace.yaml`, `GATEWAY_PORT`, `RUNNER_PORT` or
  `AW_DATABASE_PORT` in `.env`). It used to fail on one bare `port <n> is already in use` per start.

## 0.3.0 — 2026-10-04

The first release of this package on npm; there was no 0.2.1 of it.

### Added

- The local runtime as one package (ADR-0109): `dist/launch.js` (the bundled web, gateway and
  runner), `dist/bin.js` (the `./launch` export and the `agent-workspace-embedded` bin),
  `dist/web/` (the production webpack build of the web app) and `dist/migrations/`.
- `./package.json` is exported, so `aw dev` can check the runtime's version.
- The project file's policy ceiling reaches the local runtime (#534, ADR-0109 slice-2 amendment):
  `start.environment.policy` is written to `AW_DEPLOYMENT_POLICY` as canonical JSON (keys sorted,
  no whitespace). A hand-set `AW_DEPLOYMENT_POLICY` that is not a valid JSON policy ceiling, a blank
  one included, is refused as `invalid_value`, and one that differs from the project file's policy
  as `conflicting_value`; both name the variable, never its value. With no `policy` in the project
  file a valid hand-set ceiling still applies, and the runtime prints
  `warning: AW_DEPLOYMENT_POLICY is set in the environment or .env and agent-workspace.yaml has no policy; that ceiling applies`.
  The comparison is of canonical JSON, so key order and number spelling do not count but array
  order does. Declared gap: nothing in the server reads `AW_DEPLOYMENT_POLICY` yet; the ceiling is
  enforced once S2-04b lands (plan C13).
- The local runtime refuses to start when its environment, after `.env` is loaded, holds a name
  from `start.environment.withheld` in any case (#534, SD17): the message names the secret and says
  to remove it from `.env` and start `aw dev` with it in its environment instead.

### Fixed

- `aw dev` starts under WSL2 mirrored networking (#556). The embedded PostgreSQL's default port
  moves from 54329, inside Windows' dynamic range 49152-65535 that Linux cannot bind in mirrored
  mode, to 25432, outside every default ephemeral range. `AW_DATABASE_PORT` (environment or the
  project's `.env`, a whole number from 1024 to 65535) overrides it; `DATABASE_URL` still uses your
  own PostgreSQL instead; a value equal to the web, gateway or runner port is refused before
  anything starts, naming the clash. A port that cannot be bound although nothing listens on it now
  fails with `port <n> cannot be bound on 127.0.0.1, but no process is listening on it: ...`, an
  inconclusive listener check with `... and whether a process holds it could not be determined: ...`,
  and a real collision with `port <n> is already in use: ...` followed by what holds it and what to
  do, where all three used to read as "already in use" or as the generic start failure.
- The startup `Runtime:` line names the driver that actually runs, and the no-tenant-isolation
  warning is printed whenever that driver is `local`, even when the host would prefer Docker (#476).
- An agent pushed with no runtime profile can run (#504): the start creates or adopts a runtime
  profile named `local` and makes it the workspace default unless one is already chosen, and under
  posture `local` the in-process `local` driver no longer needs a Test Runtime first.
- An agent whose version names the `default` connection but no model, as a new project's scaffold
  writes it, can run (#506): the launcher sets `AW_DEPLOYMENT_DEFAULT_MODELS` to a per-provider
  deployment default (`claude-sonnet-4-5` for Anthropic, `gpt-5.1` for OpenAI) unless `.env` or the
  environment sets it, so the run is no longer refused with `422 model_connection_unresolved`.
- Ctrl+C on `aw dev` stops the runtime in order (#510): the embedded PostgreSQL postmaster is
  spawned by the runtime in its own process group (ADR-0112), so the terminal's SIGINT reaches only
  the launcher, which revokes the credential, closes the server and its database pools and then
  stops PostgreSQL. A closed terminal or console (SIGHUP) and Ctrl+Break (SIGBREAK) run the same
  ordered stop. The
  server's database pools (and the migration and bootstrap lock clients) report a failed
  connection as one `[db] … (<code>)` line instead of an uncaught `57P01` error. A launcher
  killed with SIGKILL now leaves the postmaster running, and the next start reports the embedded
  PostgreSQL's port in use until it is stopped.
- `aw dev` explains the ports it cannot use (#560). `environments.local.port` 4000 and 8080, the
  local runtime's own gateway and runner ports, are refused by `aw check` and `aw dev` with the
  file position. The launcher also refuses a port equal to the gateway or runner port `.env` sets
  (naming `GATEWAY_PORT` or `RUNNER_PORT`, read as each service reads it, so a blank `RUNNER_PORT`
  is 8080) and the embedded PostgreSQL's port unless `DATABASE_URL` is set.
  A port the process may not listen on, such as 80 as a normal user, is reported as
  `permission denied to listen on port 80; ports below 1024 need elevated privileges, choose a port from 1024 to 65535`
  instead of `the local runtime failed to start (Error)`. A second `aw dev` in a project whose
  runtime is still running is reported as
  `port <n> is already in use, and this project's local runtime may already be running (.agent-workspace/runtime.pid records process <pid>); if aw dev is running in this project, stop that aw dev before running it again`,
  from the pid the launcher keeps in `.agent-workspace/runtime.pid` while it runs. A pid cannot
  prove its process is an aw runtime, so the message never says to stop that pid, and a start whose
  services all bind over a live record (a stale pid reused by another process) re-records itself.
