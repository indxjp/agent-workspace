# `aw` — the Agent Workspace command line

A thin, scriptable client over [`@indx-workspace/sdk`](https://www.npmjs.com/package/@indx-workspace/sdk). Every command is one
SDK method; the output is a table for a person or, with `--json`, exactly the value the SDK
returned. The command tree is the API's
resources that the server serves today ([the CLI overview](https://docs.agentworkspace.indx.jp/cli/overview)) and
nothing else — a row that waits for a server change has no command rather than a stub, so
`aw --help` is an honest inventory of what the control plane can do today.

Besides that tree there are two local commands that need no control plane: `aw init` writes a new
project and `aw dev` runs it on this machine and pushes its definition files on every save (see
[Local development](#local-development-aw-init-and-aw-dev)). `aw check` and `aw push` read the
project's definition files and save them as agent versions (see
[Agents as code](#agents-as-code-aw-check-and-aw-push)).

This is the operator's CLI. `packages/cli` (`agent-workspace`) is the deployment generator; the
two share nothing but the repository.

## Five-minute quickstart

### 1. Install

```sh claim="run"
npm install --global @indx-workspace/aw   # or run it once: npx @indx-workspace/aw --version
```

`aw` is released in lock-step with `@indx-workspace/sdk` and `@indx-workspace/contracts`, at the
contracts version it speaks. Inside this repository, `pnpm --filter @indx-workspace/aw... build`
and `node packages/aw/dist/index.js` run it from the workspace instead.

### 2. Point it at a control plane

Mint an API key in the workspace (Settings → API keys, or `aw team api-keys create` from a
session that already has one). Then either export two variables:

```sh title="illustrative" claim="illustrative"
export AGENT_WORKSPACE_URL=https://aw.example.com
export AGENT_WORKSPACE_API_KEY=ak_live_…
```

or write a profile in `~/.config/agent-workspace/profiles.json`. A profile names the control
plane and the **environment variable that holds the key**; the key itself is never in the file:

```json title="illustrative" claim="illustrative"
{
  "default": { "url": "https://aw.example.com", "apiKeyRef": "AW_PROD_KEY" },
  "staging": { "url": "https://staging.example.com", "apiKeyRef": "AW_STAGING_KEY" }
}
```

```sh title="illustrative" claim="illustrative"
export AW_PROD_KEY=ak_live_…
aw agents list                     # uses "default"
aw --profile staging agents list   # uses "staging"
```

Precedence is flags (`--url`, `--api-key-stdin`, `--profile`, `--timeout <ms>`), then
`AGENT_WORKSPACE_URL` / `AGENT_WORKSPACE_API_KEY`, then the project file, then the `default`
profile — field by field, so a profile may supply the URL while the environment supplies the key.
The `default` profile's key is sent only to that profile's own URL, never to another `--url` or
`AGENT_WORKSPACE_URL`, and `aw` warns on stderr before a credential travels over plain `http://`
to a host other than this machine.
A profile named with `--profile` is a flag: its URL and its `apiKeyRef` outrank the two environment
variables, so an exported production key never travels to the staging host. The project step
applies inside a directory holding a v2 `agent-workspace.yaml`: the URL is
`http://127.0.0.1:<environments.local.port>` (`3000` when the port is not set). With that URL
neither `AGENT_WORKSPACE_API_KEY` nor a profile's key is sent — each was configured for another
control plane; the key comes from `--api-key-stdin` or the token `aw dev` stored. A file that does not parse is a usage error
naming `agent-workspace.yaml:<line>:<column>`. `--api-key <value>` is refused (it
would land in shell history); in CI, pipe the key instead:

```sh title="illustrative" claim="illustrative"
printf '%s' "$KEY" | aw --api-key-stdin agents list
```

`apiKeyRef` is an environment variable name today; an OS keychain reference is a follow-up.

### 3. Look around

```sh title="illustrative" claim="illustrative"
aw agents list
aw agents get <agent-id>
aw models discover
aw workspaces sharing-policy get
```

An API key is bound to one workspace with a fixed role; `aw me` prints which workspace and role
that is. The control plane refuses every `/api/workspaces` route to an API-key principal
(`403 api_key_not_permitted`, ADR W9-WS-119), so `aw workspaces list` is for a person signed in
with `aw login`, not for a key.

A `builder` key starts runs of the agents it created itself (`aw agents create` with the same
key); running an agent someone else created takes an `admin` or `owner` key. A `viewer` key
reads but cannot start runs: an agent grant names a person, never a key.

### 4. Run an agent

```sh title="illustrative" claim="illustrative"
aw runs start <agent-id> --prompt "Summarise the open incidents." --follow
```

`--follow` streams the run and prints the neutral `AgentEvent` view (spec §6.3): the session id,
each assistant message, each tool call and result, and the result's cost and token counts.
`--wait` instead follows silently and prints the settled run record. `--session <id>` continues
a session, `--model <connection-id>:<model>` overrides the agent's model for this run, and
`--prompt-file <path>` (or `--prompt-file -` for stdin) takes the prompt from a file.

```sh title="illustrative" claim="illustrative"
aw runs list --status completed --limit 5
aw runs follow <run-id>            # reconnects with the last event id if the connection drops
aw runs wait <run-id> --json
```

### 5. Create and change things

A create or update body comes from `--file <json>` or `--file -` (stdin); a handful of scalar
fields also have flags (`--name`, `--role`, `--email`, …) that are laid over the
file. The body is validated against the contract before anything is sent, so a typo is a usage
error (exit 2), not a round trip.

```sh title="illustrative" claim="illustrative"
aw agents create --file agent.json
echo '{"runtimeProfileId":"<profile-id>"}' | aw agents update <agent-id> --file -
aw team members add --email ada@example.com --role admin
aw skills import ./release-notes            # a directory holding SKILL.md
aw skills export release-notes ./exported
aw files upload docs/readme.md ./README.md
```

A credential never travels as a flag value. `secrets create`, `models connections create`,
`runtimes connections create`, `connectors create|test-draft`, and every `rotate-credential` /
`replace` read it from stdin with `--value-stdin` (or, for a create, from the JSON body):

```sh title="illustrative" claim="illustrative"
printf '%s' "$GITHUB_TOKEN" | aw secrets create --name GITHUB_TOKEN --value-stdin
printf '%s' "$NEW_KEY" | aw models connections rotate-credential <connection-id> --value-stdin
```

Standard input is read at most once per invocation, so `--api-key-stdin`, `--value-stdin` and
`--file -` cannot be combined; put the body in a file when the credential comes from stdin.

## Local development: `aw init` and `aw dev`

These two commands work on the current directory and talk to no configured control plane. The
decisions behind them are recorded in
ADR-0109.

### `aw init [--yes]`

`aw init` writes the starter files, rendered by `@indx-workspace/sdk/project` from the setup
answers: `agent-workspace.yaml`, `agents/<agentName>.ts` and `surfaces/main.ts` (plus
`tools/<name>.ts` when the answers choose an OpenAPI tool). The project name comes from the
directory name.

- On a terminal it asks the same setup questions as `npm create`, theme first, through the same
  loop, so the same answers write byte-identical files. It then prints the paths and asks
  `write these <n> files? [y/N]`; any answer but `y` writes nothing and exits `0`.
- `--yes` takes the recommended answers (`agents/assistant.ts`) and asks nothing. Without a
  terminal it needs `--yes`.
- If any file it would write already exists, it refuses (exit `1`), lists each one, and writes
  nothing.
- It never edits `package.json`. When `@indx-workspace/aw`, `@indx-workspace/embedded` or
  `@indx-workspace/sdk` is missing from it, it prints the line that adds them at this `aw`'s
  version, for example
  `npm install -D @indx-workspace/aw@<v> @indx-workspace/embedded@<v> @indx-workspace/sdk@<v>`
  (with `npm init -y` first when there is no `package.json`).
- It ends with the variables `aw dev` reads, `next: npx aw dev`, and
  `to share a workspace later: aw login --url <url> (reads workspaces; pushing with it is not supported yet)`.

```sh claim="run"
mkdir my-agent && cd my-agent
aw init --yes
```

### `aw dev`

`aw dev` runs the project's local runtime, signs you in to it and keeps the project's agents and
surfaces in sync with it.

- It must run inside a project (a directory with `agent-workspace.yaml`); elsewhere it refuses
  and names `aw init --yes`.
- It resolves `@indx-workspace/embedded/launch` from the project's `node_modules` (it never
  imports it) and requires the same version as `aw`. A missing or skewed package is refused with
  `npm install -D @indx-workspace/embedded@<v>`.
- It refuses an agent whose engine the project has not installed (the runtime carries no engine
  of its own, ADR-0139), naming the engine and the `npm install` line that adds its packages.
- It refuses environments it cannot run, before starting anything: a v1 profile, `storage` on
  the `local` environment, and a runtime driver other than `local`, `sandbox-runtime` or `docker`.
- It forks the runtime with an IPC channel and prints `ready <url>`, then
  `signed in as <email> (workspace <slug>)`, the address lowercased as the runtime signs in with it
  (`BOOTSTRAP_ADMIN` when set). An address holding a terminal control character is refused. The URL is `http://127.0.0.1:<port>`, the same one
  the project step of the configuration precedence gives, so `aw me` and the other commands reach
  the local runtime from the project directory.
- It stores the short-lived token in `~/.config/agent-workspace/credentials.json` (mode `0600`)
  and never prints it.
- It applies the project file's `models` and `connectors` from its own environment, before the
  first sync (C10, C11). Each is created, or its settings and credential brought in step; a
  provider or transport that differs from the server's is printed as
  `warning: <path>: <reason>` and left alone, and nothing is ever deleted. A credential names a
  variable (`credential: { secret: ANTHROPIC_API_KEY }`); an unset one prints
  `notice: <NAME> is not set: run export <NAME>=… in the shell aw dev started from, then restart aw dev` and that resource is
  skipped while the rest continues. Each MCP connector applied prints
  `connectors.<name>: MCP tools that write run without confirmation (ADR-0108)`. Without `models`,
  it creates a `default` connection from `ANTHROPIC_API_KEY` (and `ANTHROPIC_BASE_URL`, when set)
  when the workspace has none; on a later start with the key set, a changed key is rotated and the
  base URL follows `ANTHROPIC_BASE_URL` when it changed since the last start (unset clears it). Without the key it says to set it and
  restart, or, when the connection exists, that it runs on the key stored earlier. A
  refusal from the runtime is a warning and the next resource is tried.
- It keeps an HMAC fingerprint of each credential it sent, never the value, in
  `.agent-workspace/secret-fingerprints.json` (mode `0600`, under the runtime's gitignored
  directory). When a variable's value changed since the last start, the credential is sent again
  and `notice: <NAME> changed: rotating the credential` is printed. A missing or unreadable file
  sends every credential once more.
- Every variable the project names as a secret, in `agent-workspace.yaml` or in a `secret()` of an
  agent's tools, is withheld from the runtime and from the loader child, whatever its case, and
  listed in the `start` message's `withheld` (SD17). The runtime receives credentials only through
  the API. A `secret()` added while `aw dev` runs is read from `aw dev`'s environment at the next save; when it
  is set, `aw dev` prints `<NAME> was in aw dev's environment when the runtime started; restart aw dev to withhold it from the runtime`, and the name is withheld from later loaders.
- The project file's `policy` is sent to the runtime in `start`, which then refuses an agent that
  widens it; `engine` is the engine of every agent that names none (C12, C13). A save of
  `agent-workspace.yaml` while `aw dev` runs applies `models` and `connectors`; a change to `environments.local.port`, `environments.local.runtime`, `engine` or `policy` prints `agent-workspace.yaml: <key> changed; restart aw dev to apply` once.
- After sign-in and the project's models and connectors, it pushes `agents/*.ts` and `surfaces/*.ts` to
  the runtime it started, through the same path as `aw push --yes` with `local` as the only target
  (ADR-0101). It then watches `agents/`
  and `surfaces/` and the folders inside them (the `.ts` files and the `.md` instructions files)
  and pushes again about 200 ms after each save; a burst of saves gives one push. A file outside
  those two folders that a definition reads, such as an instructions file elsewhere in the project
  or a module a definition imports, is not watched: save a watched file to push its edit.
- Before each sync saves a version, it applies the agents' catalog tools (`openapiTool()`,
  `postgresTool()`) as connectors of their `name` (C15). A tool is created the first time, and
  registered again when its definition, its OpenAPI document or its secret's value changed;
  nothing is deleted. An `openapiTool`'s `spec` is read from the project (its real path must stay
  inside it) or fetched from its `https` URL with a 10-second timeout, never over a redirect to a
  URL that is not `https`; either way at most 1 MiB, or `<file>: local connector_spec_invalid
[spec: larger than 1 MiB]`. An unreadable one is
  `<file>: local tool_spec_unreadable [<spec>: <reason>]`, against the file that declares the
  tool (`tools/orders.ts`, or the agent's file for an inline tool). The credential is read from
  `aw dev`'s own environment and travels only in the connector's create or update body; an unset
  one prints `notice: <NAME> is not set: run export <NAME>=… in the shell aw dev started from, then restart aw dev` and that
  tool is skipped (C10). A name another connector already holds prints
  `<file>: local tool_refused [<reason>]`, and the server's refusal of a document prints its own
  answer, such as `tools/orders.ts: 422 connector_spec_invalid […]`; either blocks that sync's
  push until the file is fixed. `tools/` is watched like `agents/`, and so is every project
  document a tool names, so saving `tools/orders.ts` or `apis/orders.openapi.json` syncs again.
- Each sync prints one line, such as `synced: "assistant" version 3 (2 changes)`, with one part
  per agent. The other forms are `"<name>" created at version N`, `"<name>" back on version N` and
  `"<name>" unchanged at version N`.
- A sync never writes over an edit made in the UI
  (ADR-0101). When an agent was edited
  after `local` last moved (its `updatedAt` is later than the `local` pointer's; replacing its
  skills, connectors or files counts as an edit), or an agent of that name was made in the UI and
  has no `local` pointer, the sync saves no version and moves no pointer for it. It prints
  ``agents/<file>.ts: local edited_in_ui ["<name>" edited <time>, local N set <time>]; run `aw push --yes` to overwrite it with this file``
  (the detail is `"<name>" has no local pointer` for the second case) and, on stderr,
  `sync: N problem(s); those agents keep their UI edit until aw push --yes overwrites them`. The
  other agents in the project still sync and the loop keeps running; after `aw push --yes` the
  next save syncs that agent again. The check and the write are separate requests, so an edit
  made between them is still overwritten until V-2 (a declared gap of ADR-0101). An agent is
  matched to its file by name only, so an agent renamed in the UI no longer matches: the sync
  creates a new agent from the file and leaves the renamed one beside it, without an
  `edited_in_ui` line (a declared gap of S2-07b; `aw push` does the same).
- A refusal prints the same `<file>: <status|local> <code>[ [details]][; <hint>]` lines as
  `aw push`, for example
  `surfaces/main.ts: 400 invalid_agent_version [surfaces.0.theme.colour: …]`; a definition the SDK
  refuses as it loads is printed at its line, `✗ surfaces/main.ts:3:16  theme.colour: …`. Then a
  `sync:` line on stderr; when the refusal held back the whole sync, as any local or dry-run
  problem does, it says `nothing was synced`, so an edit to another file waits for the fix too.
  `aw dev` keeps running and syncs again on the next save.
- An agent whose name leaves the project (its file renamed the agent or was deleted) stays in the
  local workspace, so `aw chat` without a name then asks which agent. The next clean sync says
  so once on stderr, `notice: <file> no longer defines "<name>", …; remove it with aw agents remove <id>`. The server's
  `403 policy_cannot_widen [<field>]` for an agent beyond the project's `policy` is printed the
  same way. A network or server failure, a request
  the runtime has not answered within 30 seconds, or a project folder that cannot be read (for
  example while another program locks it) also prints `sync: <message>` and the loop continues.
- After the first sync that pushed an agent, it prints three lines once for each of that agent's
  surfaces: `page: <url>/p/s/<name>`, `try: <url>/p/s/<name>/try` and
  `widget: <script src="<url>/p/s/<name>/widget.js" async></script>`, where `<url>` is the one
  the `ready` line printed, such as `http://127.0.0.1:3000`. The `widget:` tag is the one to paste
  into a page.
- Ctrl+C stops the runtime (exit `130`): `aw` closes the IPC channel (and sends `SIGINT` outside
  Windows, where it would kill the process outright), gives the runtime 10 seconds to stop its
  database cleanly, then kills it.
- It takes no configuration or output flags: `--url`, `--profile`, `--api-key-stdin`,
  `--timeout`, `--json`, `--jsonl`, `--raw` and `--quiet` are refused by name.

```sh title="illustrative" claim="illustrative"
export ANTHROPIC_API_KEY=sk-ant-…
npx aw dev
```

`aw dev` takes no `--yes`. Besides its own credential, it writes only the project's models,
connectors and catalog tools, versions and the `local` pointer, to the local runtime it started
and through the SDK, as
ADR-0101 decides for `local`.
`aw push` without `--yes` is the read-only form of the same write. `aw dev` never edits the
project's files.

## Agents as code: `aw check` and `aw push`

These two commands read the project in the current directory and talk to the configured control
plane (inside a project, the local runtime `aw dev` started). The full walkthrough is the
[Agents as code](https://docs.agentworkspace.indx.jp/guides/agents-as-code) guide; the loader's design is
ADR-0111.

- They load every `agents/*.ts` (a `defineAgent` default export) and `surfaces/*.ts` (a
  `defineSurface` default export) in a child process, with Node's own type stripping: only
  erasable TypeScript (no `enum`, no `namespace`). An agent's `instructions: { file: './x.md' }`
  is read beside its file and must stay in the project. Surfaces are grouped into their agent by
  `agent`. The files are not sandboxed: they run as your own code with your file access; only the
  key variables (`AGENT_WORKSPACE_API_KEY`, `ANTHROPIC_API_KEY`, every profile's `apiKeyRef`) are
  withheld from their environment, and so is every variable `agent-workspace.yaml` names as a
  secret. An agent that names no `engine` is checked and pushed with the project file's `engine`
  (C12). A malformed `agent-workspace.yaml` is refused at its line and column.
- A definition, and every file it imports, may import `@indx-workspace/sdk/define` and relative
  specifiers (`./` or `../`), such as `import { orders } from '../tools/orders'`. A relative
  specifier names a `.ts` file: `.ts` is appended when it is not written, with no other lookup (no
  `index.ts`, no `.js` to `.ts` rewrite). The file's real path, after symlinks, must stay inside
  the project and must not be under a `node_modules` folder of it. Everything else is refused as
  `import_refused`: `node:*` modules, other packages, absolute or URL specifiers, specifiers that
  contain `%`, `?`, `#`, `:` or a backslash, an import with attributes (`with { type: 'json' }`),
  `.js` and `.json` files, and `import()`. A refusal is reported against the definition being
  loaded; when an imported file (another definition included) made the refused import, the second
  detail names that file, relative to the project, for example
  `agents/support.ts: local import_refused [node:fs, tools/orders.ts]`. Imported files are your own
  code: they run once per load in the same child, with the same withheld variables, and a file
  that fails gives every definition that imports it the same problem
  (ADR-0111).
- **`aw check [--json]`** dry-runs each agent against the server (the version check for an
  existing agent, a dry-run create for a new one) and saves nothing. It compares each agent with
  its newest version and `local` pointer exactly as `aw push` does, so the two always agree on
  whether a push would save anything, and prints one line per agent:
  `<file>: ok (would be version N)` when a push would create the agent or save a new version,
  `<file>: ok (unchanged, local N)` when the newest version holds the definition and `local` runs
  it, `<file>: ok (version N already holds this definition; local would move from X to N)`, or
  `<file>: ok (edited outside aw push; version N would be applied again)`. `--json` lists each
  agent as `{file, name, agentId, action, version, local: {from, to}}`, with `action` one of
  `create`, `version`, `point` or `none` (the plan `aw push` prints). Otherwise it prints one line
  per problem in the form
  `<file>: <status|local> <code>[ [details]]`, for example
  `agents/assistant.ts: 422 engine_capability_unsupported [mcp]`, and exits `1` on any problem.
  `aw check` never adds a hint; only `aw dev`'s `edited_in_ui` line ends with `; <hint>`. An agent
  beyond the project's `policy` prints the server's own answer, such as
  `agents/assistant.ts: 403 policy_cannot_widen [permissions.runCommands]` (C14): `aw check` never
  compares the policy itself.
- `aw check` also dry-runs each catalog tool (`openapiTool()`, `postgresTool()`) through the
  server's connector registration, before the agents, and prints its problems against the file
  that declares the tool, such as
  `tools/orders.ts: 422 connector_spec_invalid [$ref "./other.yaml#/X": only references within the document are supported]`.
  A tool's document is read as `aw dev` reads it (1 MiB, a 10-second `https` fetch). An
  `openapiTool` is sent with the placeholder credential `aw-check-placeholder`, never its secret's
  value; a `postgresTool` needs its connection URL from the environment, because the host in it is
  what the dry run judges, and prints the `<NAME> is not set` notice and is skipped without it.
  Until `aw dev` has created a tool, the agent's dry run may still answer
  `422 agent_definition_references_missing [connector:<name>]`.
- **`aw push [--yes] [--summary <text>] [--json]`** runs the check, then prints one plan line per
  agent and the changed paths (`+`, `-`, `~`). Without `--yes` it sends only reads and dry runs
  and exits `0`. With `--yes` it creates a new agent at version 1 with `local` set, saves a changed
  definition as a version (`via: "aw-push"`) and points `local` at it, and points `local` at the
  newest version when that version already holds the definition, so an unchanged push saves
  nothing; when the agent was edited outside `aw push` since `local` moved, it points `local` at the
  same version again, applying it over the edit. This is the explicit overwrite `aw dev` names
  when it refuses to sync over a UI edit. Agents are saved one at a time: `saved` is `true`
  only when all were, and each saved agent carries its own `saved`. `--summary` defaults to
  `aw push: <agent file>`, cut to 200 characters. When the project file declares `models` or
  `connectors` and the target is not the project's own local runtime, it prints
  `models and connectors are applied by aw dev only`: `aw push` never sends them (SD7). It does
  apply the agents' catalog tools (`openapiTool`, `postgresTool`) before it saves versions, from
  its own environment and by the rules of `aw dev`, and prints `<file>: create tool "<name>"`
  (or `update`) for each one it changed; without `--yes` it sends nothing. Code tools are not applied.

```sh title="illustrative" claim="illustrative"
aw check
aw push            # show the plan
aw push --yes      # save it
```

The raw commands behind `aw push` follow the same rule, a read-only form unless `--yes` is given:

```sh title="illustrative" claim="illustrative"
aw agents versions list <agent-id>
aw agents versions create <agent-id> --file body.json [--summary <text>] [--yes]
aw agents pointers set <agent-id> local <version> [--yes]
```

`versions create` takes an `AgentVersionBody` and saves it with `via: "api"`; without `--yes` it
prints the number it would get. `pointers set` takes the version as a positional, because
`--version` is the global switch; without `--yes` it prints `local: <from> -> <to>`.

## Output

- Default: a table for a listing (a fixed set of useful columns per resource), a `field  value`
  listing for one resource, nothing for a delete.
- `--json`: exactly the SDK's returned value, as JSON. For a listing that is the array the SDK
  method returns (the envelope's `{ agents: [...] }` is already unwrapped); for `sessions list`,
  `runs list` and `models discover` it is the whole response, because those carry more than the
  rows (`projectKey`, `nextCursor`, `unavailable`). Every `--json` value round-trips through the
  corresponding `@indx-workspace/contracts` schema, which the test suite proves per family.
- `--jsonl`: one JSON object per line — each row of a listing, each event of a stream; a command
  whose value is an envelope (`runs list`, `sessions list`, `models discover`) prints that one
  object compactly on one line.
- Streams (`runs events|follow`, `runs start --follow`): `AgentEvent`s by default (rendered for a
  person, or as JSON lines with `--json`/`--jsonl`; a platform frame such as `run-status` has no
  neutral view and is printed as itself, told apart by its `kind`); `--raw` prints the classified
  frames instead.
- `--quiet` suppresses informational notices on stderr (`run <id> started`, `next page: …`).

The only interactive prompts are `aw init`'s setup questions and confirmation on a terminal, and
the CLI never prompts for a credential.

`aw --version` prints `aw <version> (contracts <version>)`. Every request states that contracts
version in `X-Agent-Workspace-Contracts`; a control plane that does not serve it answers `426`, and
`aw` exits `1` naming both versions and the `npm install --global` of the `aw` package at the
server's minor that fixes it (`@indx-workspace/aw`).

## Exit codes

| Code  | Meaning                                                                                                                                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | success                                                                                                                                                                       |
| `1`   | the server refused the request (`ApiProblemError`); stderr carries `error: <code>: <message>`                                                                                 |
| `2`   | usage: unknown command or flag, missing argument, a body outside the contract, unresolved URL or key, an argument the SDK refused before any request (`InvalidArgumentError`) |
| `3`   | the response does not match the contract this build was made against (`ContractViolationError`)                                                                               |
| `4`   | no response: network failure or `--timeout` elapsed (`TransportError`)                                                                                                        |
| `130` | interrupted (SIGINT)                                                                                                                                                          |

## Command tree

`aw --help` prints it; `aw <family> --help` prints one family. Families: `workspaces`
(`sharing-policy`), `team` (`members`, `users`, `api-keys`), `models` (`connections`,
`discover`), `runtimes` (`profiles`, `connections`), `secrets`, `files`, `skills`, `connectors`,
`agents` (`assignments`, `versions`, `pointers`), `projects`, `sessions`, `runs`, `shares`, `metrics`, `audit`. The
local commands `init` and `dev`, and the project commands `check` and `push`, stand beside the
families.

Deliberately absent until their server change lands (spec §7.2, §8): `me` (S-8),
`runtimes detect|test` (S-9, S-4), `secrets remove` (S-10), `skills remove` (S-12),
`connectors update` (S-20), `agents policy|export|import` (S-13), `agents archive|restore`
(RF-201), `shares publish` (RF-103).

Absent because the only credential `aw` can hold is refused: `workspaces list|get|create|update`
and `team invitations list|create|resend|revoke`. Every `/api/workspaces` and `/api/invitations`
route answers an API-key principal with `403 api_key_not_permitted` (ADR W9-WS-119: a key acts
for one workspace with a fixed role and has no human membership to administer against), so a
command for them would exit 1 on every invocation. The SDK methods exist for a session-cookie
caller; a session mode for the CLI would need a way for a person to sign this binary in
(S-22). `team invitations accept` is browser-only besides.

## Layout

| Module                                        | Responsibility                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                | The entry: binds `process` to the `CliIo` boundary and runs `main` — only when it is the invoked script.  |
| `src/main.ts`                                 | Parse, configure, dispatch one command, render, classify the failure into an exit code.                   |
| `src/args.ts`                                 | The flag grammar (hand-written; no argument-parsing dependency) and the `--api-key` refusal.              |
| `src/config.ts`                               | §7.1 precedence, the profiles file and the project-file step.                                             |
| `src/inputs.ts`                               | Schemas for `--file` bodies; each is proven against its contract interface at the SDK call site.          |
| `src/output.ts`                               | Table and record rendering, `--json`/`--jsonl`, failure → exit code.                                      |
| `src/version.ts`                              | `--version` and the text for a server that does not serve this binary's contracts version.                |
| `src/stream.ts`                               | Frame rendering for `events`/`follow`: `AgentEvent`s, JSON lines, or raw frames.                          |
| `src/commands/*.ts`                           | One module per family; each command is one SDK call.                                                      |
| `src/commands/init.ts`, `src/commands/dev.ts` | The two local commands; `dev` is a thin orchestration over `src/local-runtime/`.                          |
| `src/local-runtime/`                          | The project read, runtime resolution, the IPC supervisor and the `default` model connection for `aw dev`. |
| `src/commands/project.ts`                     | `aw check` and `aw push`, thin over `src/project/`.                                                       |
| `src/project/`                                | The definition-file loader (a forked child, ADR-0111), problem lines, the diff, check and push.           |

The package depends on `@indx-workspace/sdk`, `@indx-workspace/contracts`, `zod` and Node's
built-ins, and on nothing else; `dependency-cruiser` enforces it.
