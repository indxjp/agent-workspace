# Changelog — `@indx-workspace/aw`

One heading per release, newest first. Each lists what was **added**, **deprecated** and
**removed**; a removal names the release that deprecated it. Removals and renames happen only in a
major release, no earlier than one minor after the deprecation. The full rule, the served range and
what the policy covers are on the developer site's
[Public surface and stability](../../docs/sdk/site/concepts/public-surface.mdx#versions-and-deprecation)
page. Released in lock-step with `@indx-workspace/sdk`, with the same version.

## 0.6.12 — unreleased

### Added

- `aw storage connections update <name|id> --write-allowed` turns writing on for a connection
  without a `--file` body. Turning writing off still goes through `--file`.
- `aw init --features chat,files` names the features the project's deployment installs, and writes them as `features:` in `agent-workspace.yaml`. Accepting the default writes no `features:` line.
- `aw workspaces features list` shows which features are on, with what each needs;
  `aw workspaces features disable <id>` and `enable <id>` switch one off or on (Owner only). All
  three take `--workspace <id>` and default to the workspace you act in.

### Changed

- `aw files upload` streams the local file from disk instead of reading it into memory first, so
  a large file no longer needs its size in free memory. A path that is not a regular file is
  refused as a usage error before any request.
- `aw storage connections update` refuses `--file -` together with `--credential-file -` as a
  usage error, since both would read stdin, and `aw storage connections credential` refuses an
  extra positional argument before it looks the connection up, without repeating it, since it may
  be a pasted credential.

### Fixed

- `aw runs start --attach` drops every empty and `.` segment of a workspace path, so
  `././reports/./q3.txt` names `reports/q3.txt` like `./reports/q3.txt` does. A `..` segment is
  still refused.

## 0.6.11 — unreleased

### Added

- `aw agents new --from-prompt "<text>" [--out <dir>]` builds an agent with the Builder in a chat on your terminal. Every save, trial and check shows what it will do (the diff against the base version, the trial input and budget cap, or the case names and budget cap), names the agent, and waits for `y`. A saved agent is written as `agents/<name>.ts` and `.md`. It needs a terminal on stdin and stdout and has no `--yes`. It answers "the Builder is not enabled for this workspace" until the Builder is enabled for the workspace.
- `aw audit list` prints a `builderRunId` column, and `--json` carries the field.
- `aw endpoint-clients create --kind builder --name <name>` creates the client of the Builder's MCP door. It takes no `--agent`, and it authorizes through OAuth consent only, so it cannot mint keys.

### Deprecated

- The JSON + base64 skill import is deprecated and is removed in the next major release.
  `aw push` and `aw dev` no longer use the deprecated JSON form internally, so they never trigger
  the SDK's deprecation warning.

## 0.6.10 — unreleased

### Added

- `aw triggers list|get|create|update|remove` and `aw triggers secret rotate`; the Zoom secret
  token is read with `--value-stdin`.
- `aw runs` and `aw chat` print a `run.warning` frame as a warning line (as itself with
  `--json`/`--jsonl`/`--raw`) instead of failing on it.
- `aw runs outputs <id> [--download <dir>]` lists the files a completed run wrote to its
  `outputs/` directory and saves them under a local directory.
- `aw runs start --output-schema <path>` asks for a structured answer from a JSON Schema file,
  checked against the contract's limits before anything is sent; `aw runs get` shows the run's
  `output`.
- Streamed runs print `handed to a person: <reason>` for the new `agent.handoff` event, and the run trace reads a run that ends in one.
- `aw agents export <id> --format ts [--agent-version <n>] [--out <dir>] [--force]` writes a saved version as `agents/<name>.ts` and `.md`, ready for `aw check && aw push`. It refuses to overwrite without `--force` and names the path of anything it cannot write as code. The default `--format json` is unchanged.
- `aw runs start --attach <file>` (repeatable) starts the run with workspace files attached read-only; `<file>` is a file id or a workspace path. Uploading a local file is not part of it yet.
- `aw storage connections list|get|create|update|remove|test`, `aw storage connections credential <name>` and `aw storage ls <name>[/<prefix>]` manage and browse storage connections. A credential is read from `--credential-file <path>` or stdin (`--credential-file -`), never from a flag, and is never printed.
- `aw deploy` carries the tool `identity` setting from the project file to the platform.
- `aw runs get` prints the `version` of the agent the run executed.
- `aw runs start --file-scope <path>` (repeatable) narrows the run to part of the agent's file grants.
- `aw triggers create --file` and `aw triggers update --file` accept an `outputSchema`, which makes
  the runs the trigger starts answer in that JSON Schema.
- `aw triggers create --subject <caller>` and `aw triggers update --subject <caller>` set the caller
  the trigger's runs assert; `aw triggers list` shows it. Clear it with `--file` and
  `{"subject": null}`.

### Changed

- The implicit `default` profile's key is sent only to that profile's own URL: with `--url` or
  `AGENT_WORKSPACE_URL` naming another control plane, pass `--profile`, `--api-key-stdin` or set
  `AGENT_WORKSPACE_API_KEY`. When a stored sign-in is used instead, `aw` says so on stderr.
- `aw` warns on stderr before sending a credential over plain `http://` to a host other than this
  machine.
- `aw files upload` switches to a signed link above 64 MiB, and `--direct` now completes the upload and prints the ready file (it used to print `{ path, sizeBytes, transfer }`).

### Fixed

- A failed write of `credentials.json` or `local-credentials.json` no longer leaves the temporary
  file holding the token behind.

## 0.6.9 — 2026-10-14

### Changed

- `aw dev` keeps the local runtime's secrets in `.agent-workspace/secrets/local-secrets.json`, a
  sibling of the run workspaces rather than one of their ancestors, and moves an existing
  `.agent-workspace/local-secrets.json` there on the next start.

## 0.6.8 — 2026-10-14

### Changed

- A Claude run now names an MCP connector's tools `mcp__<connector-key>__<tool>` when the connector's
  name is a usable slug, instead of `mcp__connector-<uuid>__<tool>`, so a model no longer mistypes
  the UUID; other names fall back to `connector-<id>`. A stored allow or deny rule written against
  the UUID form still applies, and a rule written against the key is saved in the `connector-<id>`
  form, so it follows the connector through a rename (#1109, #1119).

### Added

- The agent policy response carries an optional `connectorNames` (`connector-<id>` → the connector's
  current key) so a rule stored by connector id can be shown with the label its owner sees in a
  run; the `engine_switch_would_widen` message labels the refused rules the same way (#1121, #1125).
- `aw dev` refuses an agent whose engine the project has not installed, with the `npm install`
  line that adds it; `aw init` includes the chosen engine's packages in its install line (#691).

## 0.6.7 — 2026-10-13

### Added

- `aw runs trace` prints each step, tool call and result as an offset from the run start, plus tool
  call-to-result duration; `--json` carries `at`/`calledAt`/`answeredAt` (#1113).

## 0.6.6 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.5 — 2026-10-13

### Changed

- `aw dev` and `aw push` print an actionable hint for `422 agent_definition_references_missing` (#1100).

## 0.6.4 — 2026-10-13

No changes; released in lock-step with the other packages.

## 0.6.3 — 2026-10-12

### Added

- `aw platforms publish` prints the executor's next steps (`next: …`) before it exits `3` for pending
  changes, so a plan names the login or connection it needs (issue #976, part of).

## 0.6.2 — 2026-10-12

### Added

- `aw init --platform <a>[,<b>…]` (and the matching question) writes the `platforms:` block and the
  README and AGENTS.md sections for the chosen agent platforms (issue #977, part of). An unknown
  platform id is a usage error.
- `aw endpoint-clients secret rotate <id>` prints the OAuth client secret once, and `aw endpoint-clients
  update` takes a repeatable `--redirect-uri` (issue #971, part of; ADR-0134).
- `aw platforms publish --platform <id>` (issue #975, part of; ADR-0133 D11): exports the agent,
  then shows the vendor tool's own plan and publishes it only with `--yes`. A plan with changes exits
  `3`; `--plan` with `--yes` is a usage error; `--strict` still exits `5` before any vendor call.
  Claude Managed Agents runs `ant apply --dry-run .` then `ant apply --yes .`, Microsoft 365 runs
  `atk validate`, `package`, then `provision`. Credentials come from the vendor tool's own login and
  are never stored or printed. `aw platforms doctor` also warns when a vendor tool is missing or too
  old. Needs `@indx-workspace/cli`, loaded only through `packages/aw/src/cli-bridge.ts`.
- `aw platforms export` prints `/` in every path it shows on Windows too (issue #972).
- `aw platforms list|export|import|doctor` (issue #972, part of; ADR-0133): `export --platform <id>`
  compiles the project's agent (`agents/*.ts` or `agents/*.agent.md`) into a platform's files under
  `platforms/<id>/`, prints a per-field verdict table and always writes `PLATFORM_REPORT.md`;
  `--strict` exits `5` when any field is dropped. `import --from <id> <path>` turns a platform's
  agent files into `agents/<name>.agent.md`, `doctor` checks that each enabled platform compiles,
  and `list` shows every agent platform. A new exit code `5` means `--strict` found dropped fields.
- `aw push` saves a project's agents in subagent order (a subagent before the agent that names
  it, otherwise alphabetical), refuses a cycle locally as `subagent_cycle` before any request, and
  reports the server's `agent_subagent_unusable` (issue #969, part of; ADR-0133 D14). A dry run
  accepts an agent whose only missing subagents are project agents the workspace lacks yet.
  `description`, `subagents` and `knowledge` of a definition now reach the saved version body.
- `aw endpoint-clients list|get|create|update|revoke` and `aw endpoint-clients keys create` (issue
  #949, closes; ADR-0134). `--agent` takes agent names and may repeat on these commands; `keys create`
  prints the key once.

### Changed

- `aw eval` runs every evals file as an evaluation run, however few cases it has, instead of one
  synchronous request for 20 cases or fewer. The synchronous request shared one 225 s budget across
  the file, so the last cases of a slow agent ended `deadline_exceeded`; a run gives each case its
  own deadline. A server without evaluation runs still gets the synchronous request, for up to 20
  cases. The output and `--json` shape are unchanged (issue #1021, part of; #881).
- `aw eval run` prints the stored error of a failed case's run under its line, as
  `run <runId>: <error>`, when the case has an uncoded `run_<status>` failure (`run_failed`, ...):
  the error is the public sentence naming the failing hop, e.g.
  `The runtime could not be reached.`. `--json`, `--jsonl` and `--junit` output are unchanged
  (#827, part of).

## 0.6.1 — 2026-10-11

0.6.0 was cut as platform images only and its packages were never published to npm, so its entries ship in 0.6.1.

### Added

- `aw deploy production` for a `target: vercel` environment passes the project directory, so its
  `web/` frontend deploys as a Vercel project, and says the control plane allows the frontend's
  origin by itself and that a custom domain goes in the surface's `allowedOrigins` (#830, part of;
  ADR-0126, ADR-0128).

### Changed

- `aw push --yes` of a project with code tools works against a deployment whose operator enabled
  the tool sandbox: after the agents' dry runs pass it creates the `aw-dev-tools` connector (an
  `http` connector with no credential at the reserved URL
  `https://tool-sandbox.invalid/mcp`), uploads each tool's bundle and saves the version that pins
  its digest; `aw check` reports the connector as one the push will create, and `aw push` without
  `--yes` lists it. A connector of that name that `aw push` did not make is refused with
  `tool_host_connector_conflict` and never re-pointed. A deployment without the sandbox refuses
  the version by name, `code_tool_needs_host`, before anything is created (#847).
- `aw promote` and `aw rollback` of a version with code tools succeed on a deployment whose
  operator enabled the tool sandbox (`AGENT_WORKSPACE_TOOL_HOST_IMAGE`, ADR-0118 TS8); the bundle
  each version pins moves with it. Elsewhere, which is the default, the server still refuses with
  `code_tool_needs_host` and `aw` says the deployment cannot run the tool (#792).
- A project whose `runtime.default` is `sandbox-runtime` still starts under `aw dev`, but the
  driver has no implementation (#818): the session runs on `local`, says so once and prints the
  no-isolation warning.

### Fixed

- `aw check`, `aw push` and `aw dev` refuse a `skills/<name>/SKILL.md` with no frontmatter, invalid
  YAML, a `name` other than the folder's or an empty `description`, at its line (BH061-021).
- A definition the SDK refuses as it loads is printed at the line of its `defineAgent()` or
  `defineSurface()` call, `✗ <file>:<line>:<column>  <details>` (BH061-046).
- `aw check` refuses `model: { connection, id }` with an `id` the connection's discovered models
  do not include, as `model_not_found`; a `model: '<id>'` refused as a missing
  `model-connection` carries a hint with the `{ connection, id }` form (BH061-019).
- `aw dev` says `nothing was synced` when a refusal held back the whole sync, and says once when an
  agent left the project but stays in the local workspace (BH061-047).
- `aw eval add-case` keeps the eval file's comments and frames the rating's comment as the fault
  the judge checks for (BH061-049).
- `local_runtime_key_not_permitted` prints a `fix:` line naming the console's API keys page
  (BH061-017).

### Added

- `aw tool call <name> [--input <json>|-]` runs one code tool from `tools/` through the same local
  tool host `aw dev` starts and prints its result, without a chat turn; the tool's own output goes
  to stderr and a tool error exits 1 (issue #800).
- `aw runs trace <id>` prints a run's steps and tool calls as a tree, with each call's input and
  output, the engine's reported tokens and cost for the run and its metered tokens and cost;
  `--json` prints the whole tree (issue #800).
- `aw push` pins each code tool's declaration beside its bundle digest in the version's
  `toolBundles` entry: description, JSON Schemas, timeout, and the `secrets` and `allowedDomains`
  the tool declares (issue #791, ADR-0118 TS4, TS5). A tool's declared secrets count as secrets
  the project references. A server older than this release refuses the extra keys.
- The code-tool host serves a session's tools over MCP Streamable HTTP to a per-run bearer token
  (`./tools/host`, hosted mode). The `tool-host` image uses it; it is not a supported surface and
  `aw dev` is unchanged (issue #791, ADR-0118 TS3, TS7).
- The hosted code-tool host launches the `stdio` MCP servers of a version (`stdioServers`, pinned
  `npx <package>@<exact version>` only) and serves each at `/stdio/<name>/mcp` behind the same
  bearer check. A server that cannot start, or later exits, ends the host. Not a supported
  surface (issue #793, ADR-0118 TS6).

- `aw dev --sandbox <local|docker>` (#786). `docker`, or `runtime.default: docker` in the project
  file, runs every agent of the session in a container: the local runtime starts the docker runner
  manager, makes a `docker` runtime profile (open network, a 1024 MB tmpfs `/workspace`) the
  workspace default for the session, and verifies it can start a container before it says ready. It
  is refused before anything starts, with one error, when `docker version` does not answer, and the
  start fails when the runtime image (`RUNTIME_IMAGE`, by default `agent-workspace/runtime:dev`)
  cannot run; nothing falls back to `local`. `--sandbox` wins over the project file, and the default
  stays `local` with no Docker needed. A project whose file already says `docker` is now refused
  when Docker is down (it used to start, on `local`). On the `local` driver an agent with
  `runCommands` prints one `warning:` line per start.
- `aw eval run [agent] [version]` (#799), the same command as `aw eval`, with three flags for CI:
  `--min-score <0..1>` exits 1 when an agent's score (passed over total) is below it, in place of
  "any case failed"; `--junit <file>` writes a JUnit report, with one `testsuite` per agent and
  one `testcase` per case, even when the run fails; `--baseline <evaluationId>` prints the
  per-case difference (regressed, fixed, added, removed) from an earlier evaluation of the agent,
  and adds a `baseline` key to `--json`. An `evals/<agent>.yaml` file may hold up to 200 cases: a
  file of more than 20 runs as an evaluation run that the CLI advances until it completes, printing
  its progress and, if interrupted, the run's id. A case's `tool` check takes an optional
  `toolInput`.
- `aw deploy production` for `gcp-cloudrun` works without `--infra`, using the module shipped with
  `@indx-workspace/cli`, and its next steps name that module's directory. `--yes` copies the release
  images into the project's Artifact Registry by digest, then exits 3 and asks for `--plan` before
  anything is applied (#794).
- `aw check` and `aw push` bundle each code tool (`defineTool`) with esbuild into one ES module
  (Node built-ins stay external, every other import is bundled in), address it by its SHA-256 and
  pin the digest in the agent version's `toolBundles`. `aw push --yes` uploads a bundle the
  workspace lacks, once, before it saves the version; a second push of the same source uploads
  nothing and saves no version. A run file that is missing, does not compile, needs a native addon
  (named by tool and package) or imports the database layer is a problem on the tool's file, and
  nothing is uploaded. The plan prints a `tool bundle` line per tool and `--json` gains `bundles`.
  `aw dev` is unchanged and its versions carry no `toolBundles`. `esbuild` is now a dependency of
  `@indx-workspace/aw` (#790).
- `aw push --yes` applies the project's catalog tools (`openapiTool`, `postgresTool`) before it
  saves agent versions, through the same calls `aw dev` uses, so a CI job no longer fails with
  `agent_definition_references_missing`. The plan lists each tool as `create` or `update` (a
  `tools` key in `--json`); a second push is a no-op. Code tools (`defineTool`) are bundled, not applied (#790, below).
- `aw dev` ready screen (UX-C, #760): the `try` page, a new `console` row (URL, sign-in email and
  the file holding the first-run password, never the password) and `npx aw chat` come first. On a
  terminal it asks `Open the chat in your browser? (Y/n)` (Enter opens it); `--open` opens without
  asking, `--no-open` never asks; `--quiet` and non-terminal output never ask, and `--open` still opens
  under `--quiet` (an explicit request). The question is printed after the first sync's lines.
- `aw init` writes the `AGENTS.md` a coding agent follows to run the project, and keeps an existing
  one the way it keeps `README.md` (#760). It also makes sure `.gitignore` lists `.env` and `.aw/`,
  creating the file or appending only the missing lines, so the key file and the runtime's logs are
  not committed. The confirmation names the `.gitignore` it will create or edit.
- When `aw dev` is run in a terminal with no model key, it offers a numbered choice (Enter takes
  the first): open the provider's console to create a key (Anthropic, OpenAI; the browser opens, or
  the link is printed), paste a key hidden, or skip. The line that sets a missing key is `export NAME=…`, and on Windows both PowerShell
  `$env:NAME="…"` and cmd `set NAME=…`. Ctrl-C at the menu ends `aw dev` as an interrupt. Without a
  terminal nothing is asked, as before.

### Changed

- `aw chat` against a local `aw dev` runtime with no model key prints one line (#760): `no model
key: <the line that sets it for your shell>, then restart npm run dev (it will offer to open the
console)`, in place of the long `model_connection_unresolved` text. Other targets keep the full text.
- `aw init` asks every choice and multi setup question as an arrow-key menu on a terminal (up/down
  or `k`/`j`, space toggles, Enter accepts, Ctrl-C exits) with the recommended answer preselected,
  and the file confirmation is a Yes/No menu defaulting to Yes. Without a terminal nothing
  changes (UX-A, #760).

## 0.5.0 — 2026-10-06

The first-hour programme (tracker #687, FH-01 to FH-13): `aw dev` gets from `aw init` to a first
answer, a first tool, a first skill and a first embedded chat without leaving the terminal.

### Added

- Code tools (#693, ADR-0115, FH-06): `aw dev` starts a tool host that serves `defineTool` run
  files over a local connector (`aw-dev-tools`), refuses to re-point a foreign connector of that
  name, and refuses a version that lists a code tool outside `local`.
- Skills sync (#694, FH-07): `aw dev` and `aw push` sync `skills/<name>/` folders (any file in
  them), `aw check` and `aw push` preview accept a new `skills/` folder, and skill API errors are
  reported as problems.
- The model key is checked at start and named on the ready screen (FH-03): a missing key is said
  once, a rejected key and an unreachable provider are told apart, and `aw dev` asks for the model
  endpoint and refuses a missing `--model-base-url` at `aw init`.
- Live `agent-workspace.yaml` (#695, FH-08): a saved project file is applied under `aw dev` without
  a restart, a save made during an apply is kept, and a newly named secret is announced with the
  export and restart it needs. `aw secrets replace` accepts a name as well as an id (#755).
- The ready screen lists the eval cases (#698, FH-11) and, in a project with `@indx-workspace/react`,
  a hint for the chat component (FH-12).
- The `support`, `copilot` and `automation` starters write complete projects with a `README.md`
  and evals that run in tests (FH-09, #696).

### Fixed

- `aw eval` prints a sentence and a next step for `judge_unparseable` and `judge_unavailable` in
  place of the bare code, and `aw agents versions list` shows each version's newest evaluation
  score (`—` when it has none) as a `score` column (#736). `--json` is unchanged.
- After `aw dev` moves the web server off a busy port (`web on :3001 (3000 was busy)`), the other
  `aw` commands run in that project reach the port it bound, with the key it stored there, instead
  of the project file's port (#730). `aw dev` records the port in `.aw/runtime.json` while it runs
  and removes it on exit; a record whose `aw dev` is gone is ignored.
- `aw promote` against the project's own `aw dev` no longer moves production with "no promotion
  bar is set" when `agent-workspace.yaml` sets `policy.promotion.minEvalScore` that the running
  `aw dev` has not applied yet (#734). It runs the dry run first and, when the file's bar and the
  server's differ, refuses naming both and the restart:
  `agent-workspace.yaml sets bar 0.90, but the running aw dev has no bar; production was not moved`.
  The gate itself stays on the server.
- Restarting `aw dev` with a new `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL` now updates the
  existing `default` model connection: a changed key is rotated, and a base URL that changed since
  the last start is applied (a removed one clears it) with
  `notice: ANTHROPIC_BASE_URL changed: base URL updated to <host>` (#732). The last applied value is
  kept beside the key fingerprints in `.agent-workspace/secret-fingerprints.json`, so a base URL
  set in the UI is not overwritten while `ANTHROPIC_BASE_URL` stays the same. With
  `ANTHROPIC_API_KEY` unset the connection keeps its stored key, and the ready screen's model row
  now says so (`stored key checked (ANTHROPIC_API_KEY not set: …)`) instead of `key checked`.

## 0.4.0 — 2026-10-05

### Added

- `aw dev` checks the key of each model connection the project runs on at start (issue #661): a
  key the provider rejects, or a provider it cannot reach, is a `warning:` line naming the variable
  to set (`ANTHROPIC_API_KEY` for the `default` connection), never its value. `aw runs` and
  `aw eval` add a `fix:` line naming `ANTHROPIC_API_KEY` to `model_connection_unresolved` and
  `model_credential_rejected`.
- `aw eval` reports a case whose run failed with a model-key code by that code
  (`model_credential_rejected`, …) instead of `run_failed`, and adds the same `fix:` line. A
  rejected key or a provider that refuses the connection now fails the run within seconds instead
  of after minutes of retries, so the case no longer ends in `deadline_exceeded` (issue #661).
- `aw runs` and `aw eval` print a reachability `fix:` line (base URL, network, proxy, DNS) for the
  new `model_connection_failed` — a provider that refused the connection or did not resolve — and
  no longer the `ANTHROPIC_API_KEY` line for it (issue #661). `aw dev` hands the runtime the
  `credential.secret` names of the project's model connections (names only), so the try page names
  the variable to set before the first message.
- `aw runs rate <id> --up|--down [--comment <text>]` (issue #665) rates a run's answer from the
  CLI, as the widget's buttons do, so a thumbs-down reaches `aw feedback` and `aw eval add-case`
  without a browser.

- `aw chat [agent] [--prompt|-p <text>]` talks to an agent by name or id: one shot with `-p` or a
  piped prompt (the answer on stdout, `--json` for the settled run), or on a terminal an
  interactive loop that streams text, prints each tool call as one line, interrupts a turn on
  Ctrl-C (a second Ctrl-C exits 130), and has `/reset`, `/version`, `/exit` and `/help`
  (issue #697, #706, #720). `--agent-version <n>` or `--env local|production` runs the
  conversation on a chosen version (#725); against a 0.3.0 server these send `version`, which it
  rejects.
- `aw init` takes the setup flags `create` takes, each answering its question (`--yes` takes the
  recommended answer for the rest; a bad value is a usage error), and `aw init --help` lists them
  (#722). The rendered `package.json` carries npm's `allowScripts`.
- `aw eval` with no arguments runs every agent that has an `evals/<agent>.yaml` on the `local`
  draft and prints one block per agent, exiting 1 when a case fails; new projects get that file
  (#711). `aw eval add "<input>" [--agent <name>] [--expect-contains <text>] [--expect-tool
<name>]` appends a case to the file locally, without a server call, and refuses a case that
  would not parse (#719).
- `aw check` reads the project's `skills/<name>/` folders, refuses one that fails the import
  checks, and refuses a `skill('x')` that names neither a folder nor a workspace skill, naming the
  nearest name (#713).
- `aw dev` prints one ready screen in place of the start-up output; the runtime's output goes to
  `.aw/logs/runtime.log` (the last 20 lines and the path are printed if the runtime stops on its
  own, and the one-time bootstrap admin password is still printed on the terminal). An unpinned
  busy port set moves together to the next free one; a pinned port is still refused. `--quiet` and
  `--verbose` are new, and the local runtime no longer seeds an extra `General` agent (#715).

### Changed

- `aw promote` prints the promotion gate's refusal (issue #619) as
  `error: production refused: v8 scored 0.70 (bar 0.90). Failing cases: "…", …` and
  ``fix: run `aw eval <agent> 8` after fixing, then promote again`` (or `v8 has no evaluation`),
  exiting 1, and says `no promotion bar is set; production needs no evaluation` on stderr when the
  deployment sets no bar.

## 0.3.0 — 2026-10-04

### Added

- `aw deploy production [--plan | --yes]` (issue #621) deploys the project's
  `environments.production` (`target: single-vm`) through `agent-workspace deploy`, loaded from
  `@indx-workspace/cli`, now an optional peer dependency: without it `aw deploy` refuses with
  "install @indx-workspace/cli". It plans by default and exits 3 when changes are pending;
  `--plan --yes` is a usage error. After an apply it prints the Caddy and `aw login` next steps and
  the path of the `.env` holding the Owner's password, never the password.
- `aw deploy production --infra <dir>` (issue #621) deploys `target: gcp-cloudrun` through the
  Terraform module in the named `infra/` checkout. After an apply it names the `terraform output`
  commands for the web URL and the Owner's password, never the password.
- `aw feedback [agent] [--negative] [--since 7d]` (issue #620) lists the ratings of the agent's
  runs since then (default a week; `<n>d` or `<n>h`): run id, rating, input, answer and comment.
  `aw eval add-case <runId> [--yes]` prints the case a thumbs-down on the run becomes — the run's
  prompt as `input`, the comment (or `Must not repeat: <answer>`) as `expect.judge`, and
  `fromRun` — as a diff of `evals/<agent>.yaml`, and appends it with `--yes`. The file is
  rewritten in the canonical form, so the diff shows any comment it drops.
- `aw eval [agent] [version]` (issue #618) runs `evals/<agent>.yaml`'s cases against a version
  of the agent on the server, which scores and stores the evaluation; it prints a table of the
  cases and `v<n>: <passed>/<total> passed (<score>), stored as evaluation <id>`, and exits 1 when
  any case fails. The version defaults to the one `local` points at, and the agent to the only
  file in `evals/`. A missing or invalid case file is a usage error (exit 2) at its line.
- `aw init [--yes]` writes the three project files (`agent-workspace.yaml`, `agents/assistant.ts`,
  `surfaces/main.ts`) rendered from the recommended setup answers, refuses when any of them exists,
  asks once on a terminal and needs `--yes` without one. It never edits `package.json`; it prints
  the `npm install -D` line for the missing `@indx-workspace/*` packages (#451).
- `aw dev` runs the project's local runtime (`@indx-workspace/embedded/launch`, same version as
  `aw`) over IPC, prints `ready <url>` and `signed in as <email> (workspace <slug>)`, stores the
  short-lived token in `credentials.json` without printing it (C5), and creates the `default` model
  connection from `ANTHROPIC_API_KEY` when none exists (C6). Ctrl+C stops the runtime (#451).
  The address it signs in as, the project's bootstrap Owner or the runtime's `BOOTSTRAP_ADMIN`
  override, must pass the contract's `BootstrapAdminSchema`: a value that holds a control
  character or is not an email address is refused before anything starts, without echoing it
  (#483).
- Configuration precedence gains a project-file step: inside a directory with a v2
  `agent-workspace.yaml`, the URL is `http://127.0.0.1:<environments.local.port | 3000>`, after
  `AGENT_WORKSPACE_URL` and before the `default` profile. Only `--api-key-stdin` or the token
  `aw dev` stored is sent to it, never `AGENT_WORKSPACE_API_KEY` or a profile's key (#451).
- The `--yes` switch, taken by `aw init` (#451) and by `aw push`, `aw agents versions create` and
  `aw agents pointers set` (#452).
- `aw check [--json]` loads the project's `agents/*.ts` and `surfaces/*.ts` with Node's own type
  stripping in a child process with a closed module linker (ADR-0111), then dry-runs each agent
  against the server and compares it with its newest version and `local` pointer exactly as
  `aw push` does. It prints `<file>: <status|local> <code>[ [details]]`
  per problem, or one line per agent: `<file>: ok (would be version N)` for a new agent or a
  changed definition, `<file>: ok (unchanged, local N)`,
  `<file>: ok (version N already holds this definition; local would move from X to N)` or
  `<file>: ok (edited outside aw push; version N would be applied again)`. With `--json` each agent
  is `{file, name, agentId, action, version, local: {from, to}}`, `action` being `create`,
  `version`, `point` or `none` as in `aw push`'s plan. It exits `1` on any problem (#452, #559).
- `aw push [--yes] [--summary <text>] [--json]` runs the check, prints the plan and the changed
  paths per agent, and saves only with `--yes`: a new agent is created at version 1 with `local`
  set, a changed definition is saved as a version (`via: "aw-push"`) and `local` points at it, and
  an unchanged one points `local` at the newest version instead of saving it again, or again at
  the same version when the agent was edited outside `aw push` since (#452).
- `aw agents versions list <id>`, `aw agents versions create <id> --file <json> [--summary <text>]
[--yes]` and `aw agents pointers set <id> <environment> <version> [--yes]`. Without `--yes`, the
  create runs the server's check and the pointer move only reads (#452).
- The `--summary <text>` flag, validated against the contract's version summary (#452).
- `aw dev` syncs `agents/` and `surfaces/` to `local` on start and on every save, through the same
  path as `aw push --yes`, prints a one-line `synced:` summary per sync, keeps running on a
  refusal or a failed request, and prints the `page:`, `try:` and `widget:` lines for each surface
  after the first sync (#453).
- `aw check`, `aw push` and `aw dev` load the project-relative `.ts` modules a definition imports
  (for example `import { orders } from '../tools/orders'`), transitively and inside the project
  only; `@indx-workspace/sdk/define` stays the only package. A refused import made by an imported
  file is reported as `import_refused [<specifier>, <importing file>]` (ADR-0111 amendment, #548).
- `aw push --json` agents carry `surfaces`, the names of the agent's surfaces in body order (#453).
- `aw dev` applies `agent-workspace.yaml`'s `models` and MCP `connectors` from its own environment
  before the first sync, prints the C10 notice for an unset variable, a refusal for a provider or
  transport the server holds otherwise, and
  `connectors.<name>: MCP tools that write run without confirmation (ADR-0108)` for each MCP
  connector applied. It keeps HMAC fingerprints of the credentials it sent in
  `.agent-workspace/secret-fingerprints.json` and rotates one whose variable changed on the next
  start (SD16). Every variable named by the project file or a `secret()` is withheld from the
  runtime and the loader child, in any case, and listed in `start.environment.withheld`; the
  file's `policy` is sent in `start`. A `secret()` added or an `agent-workspace.yaml` edited while
  it runs prints a restart line (C10–C13, SD4, SD5, SD17, #547).
- `aw check` and `aw push` read `agent-workspace.yaml`: an agent that names no engine uses the
  project's `engine` (C12), the file's secret names are withheld from the loader, and a malformed
  file is refused at its line and column. `aw push` to a workspace other than the project's local
  runtime prints `models and connectors are applied by aw dev only` when the file declares them
  (SD7, #547).

- `aw dev` applies the agents' catalog tools before each sync saves a version (#549, C10, C15):
  each `openapiTool()` or `postgresTool()` becomes, or is registered again as, a connector of its
  `name` when its definition, its OpenAPI document or its secret's value changed. The document is
  read from the project (inside it, at most 1 MiB) or fetched from an `https` URL (10-second
  timeout, no redirect to a URL that is not `https`, at most 1 MiB); the credential comes from
  `aw dev`'s environment and travels only in the create or update body, and an unset one prints
  the C10 notice. A refusal is printed against the file that declares the tool and blocks that
  sync's push. `tools/` and every project document a tool names are watched.
- `aw check` dry-runs each catalog tool's connector before the agents and prints its problems
  against the tool's file, such as `tools/orders.ts: 422 connector_spec_invalid […]`. An
  `openapiTool` is sent with the placeholder credential `aw-check-placeholder`, never its secret.
  `aw push` applies no tools (SD7).
- `aw init` asks the setup questions of `npm create` on a terminal, through the same loop, and
  writes the same files for the same answers; `--yes` is unchanged. It ends with the variables
  `aw dev` reads, `next: npx aw dev` and the `aw login` hand-off line (S2-06b, #544).

### Changed

- `aw dev` no longer syncs over an agent edited in the UI after `local` last moved (replacing its
  skills, connectors or files counts) or made in the UI without a `local` pointer: it writes
  nothing to that agent and prints
  ``<file>: local edited_in_ui ["<name>" edited <time>, local N set <time>]; run `aw push --yes` to overwrite it with this file``
  (or the `"<name>" has no local pointer` detail) and
  `sync: N problem(s); those agents keep their UI edit until aw push --yes overwrites them` on
  stderr. The other agents still sync and the loop keeps running; `aw push --yes` still
  overwrites the edit. The `"<name>" version N applied again over an edit made outside aw` synced
  form is gone from `aw dev`. A problem line may now end with `; <hint>`; only `aw dev`'s
  `edited_in_ui` line carries one. An agent renamed in the UI is still matched by name only, so
  `aw dev` and `aw push` create a new agent from the file beside it (a declared gap) (ADR-0101
  SD11, #546, S2-07b).

### Fixed

- An id the SDK refuses before any request (`InvalidArgumentError`, `invalid_path_segment`), such as
  `aw agents get ..`, is reported as a usage error: `error: <message naming the value>` and the
  `aw --help` hint, exit `2`, instead of `error: unexpected: …` with exit `1` (#496).

## 0.2.1 — unreleased

### Fixed

- An empty or blank id argument or id flag (`--id`, `--agent`, `--project`, `--session`) is refused
  before any request, naming the argument (#416). `aw runs start ""` no longer sends
  `POST /api/agents//runs`.

## 0.2.0 — unreleased

### Added

- A run that failed with a coded error prints `error: <code>: <message>`, the code apart from the
  sentence (issue #393).
- `aw runs start --wait|--follow --fail-on-error` exits `1` when the run it waited for or followed
  ends `failed`, naming the failure's code. `--fail-on-error` without `--wait` or `--follow` is a
  usage error.

## 0.1.3 — unreleased

### Changed

- Lock-step patch release with `@indx-workspace/cli` 0.1.3, which pins platform images 0.1.2.
  `aw --version` prints `0.1.3`; no other change.

## 0.1.2 — unreleased

### Changed

- Lock-step patch release with `@indx-workspace/cli` 0.1.2 (issue #389). `aw --version` prints
  `0.1.2`; no other change.

## 0.1.1 — unreleased

### Changed

- Lock-step patch release with `@indx-workspace/cli` 0.1.1 (issue #377). `aw --version` prints
  `0.1.1`; no other change.

## 0.1.0 — unreleased

### Added

- Published to npm as `@indx-workspace/aw` with the `aw` bin, in lock-step with
  `@indx-workspace/sdk` at `CONTRACTS_VERSION`: `npx @indx-workspace/aw` or
  `npm install --global @indx-workspace/aw` (issue #246, ADR-0082, P-3).
- `aw --version` prints `aw <version> (contracts <version>)` without reading configuration or
  touching the network (issue #244, ADR-0078).
- A server that does not serve this binary's contracts version exits `1` with
  `error: contracts_version_unsupported`, both versions, and the `npm install` of `@indx-workspace/aw` that fixes it (`AW_PUBLISHED_PACKAGE`).
- One command per SDK method a stored API key may call, with table, `--json` and `--jsonl` output
  and stable exit codes.
