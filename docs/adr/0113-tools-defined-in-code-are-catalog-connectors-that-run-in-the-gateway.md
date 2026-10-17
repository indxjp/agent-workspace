# ADR-0113 — Tools defined in code are catalog connectors that run in the gateway

Status: accepted
Date: 2026-10-03
Decided by: the implementing agent of the developer-journey delivery (S2-00b, issue #521), on the Owner's delegation of 2026-10-02 ("decide yourself, ask nothing")
Scope: `packages/contracts` (connector kinds `openapi`/`postgres`, the secret reference), `packages/gateway` (the `/v1/tools/<connectorId>/mcp` endpoint), `packages/core` (the new `runs.tool_connector_ids` column and connector kinds, migration in S2-02b), `apps/web/server/compose` (tool connectors as `http` MCP servers), `packages/sdk/define` (`openapiTool`, `postgresTool`, `secret`), `packages/aw` (`dev`: secrets, fingerprints, child environments); extends ADR-0103 and ADR-0102; plan decisions SD1–SD4, SD13–SD17

## Context

The developer journey promises that a developer writes `openapiTool(...)` or `postgresTool(...)`
in `tools/*.ts`, adds it to an agent, and the agent can call that API or database with no
self-hosted MCP server (D-1, D-2 in
the developer-journey document). D-2 said the tools "run
inside the runner". The slice-2 scouts of `main` (plan §8, slice 2,
the delivery plan) found that the runner is the wrong place,
and every reference below was re-checked on `main` at `8389959d`:

- **The runner is the sandbox's process.** The runtime image's entry point is the runner
  (`runtime.Dockerfile:260`, `CMD ["node", "/srv/apps/runner/dist/index.js"]`). Whatever the
  runner executes, the agent's sandbox can reach.
- **Under egress `none` the sandbox reaches only the gateway.** `buildDockerRunArgs`
  (`packages/runtime/src/docker.ts:233-253`) maps `none` to the internal `agent-egress` network,
  not Docker's `--network none`, precisely so that "the gateway must remain reachable". Running a
  tool in the runner therefore means opening egress for the sandbox and putting the API token or
  database URL inside it. That breaks the rule that only the per-run token enters the sandbox.
- **The `local` driver has no sandbox at all.** `packages/runtime/src/local.ts:9-12`: the agent
  does everything "as the runner process, on the runner's host, with the runner's credentials"
  (`isolation: 'none'`, `networkPolicies: ['open']`). Fresh projects run on this driver.
- **The existing MCP server key is long.** `connectorMcpServerName`
  (`apps/web/server/compose/resource-loader.ts:68-72`) keys every connector `connector-<uuid>`,
  46 characters. A Claude tool name is `mcp__<server>__<tool>`, capped at 64, so a tool keyed this
  way has at most 64 − 5 − 46 − 2 = 11 characters for its operation name.
- **`aw dev` forwards its whole environment to the runtime.** `packages/aw/src/local-runtime/
  supervisor.ts:110-113` forks the runtime with `env: { ...io.env }`. A token a developer exports
  for `aw dev` is, today, in the runtime's environment and so one `env` read away from an agent.

The scouts also found two existing defects in this area, which slice 2 does not fix and files
as issues (see "Declared gaps"): existing MCP connectors put their decrypted credential into the
`RunRequest` (`resource-loader.ts:266-282`), and §23 agent secrets are never wired into run
composition (`apps/web/server/composition/register.ts:1132-1137`, an empty `{}` secrets map).

The gateway, on the other hand, already has what a tool needs. It authenticates every request
with the per-run token (`authenticateGatewayRequest`, `packages/gateway/src/auth.ts`), it runs in
the control plane where the database and the sealed secrets are, it makes outbound calls through
the platform's guarded egress (`packages/core/src/net/egress-policy.ts`, `EGRESS_ALLOW_HOSTS`),
and every sandbox can reach it under every egress policy.

## Decision

Each subsection records one decision of the plan's table "Decisions slice 2 makes before
implementation" (the delivery plan §8, slice 2), with its
reason and the slice-2 contract it fixes. SD5 and SD6 (the policy ceiling) are recorded in
[ADR-0102](0102-content-owners-edit-engineers-build-admins-narrow-stop-and-approve.md)'s
"Slice 2 acceptance". SD12 (project-relative modules in the definition loader) is recorded in
[ADR-0111](0111-aw-loads-definition-files-in-a-child-with-a-closed-module-linker.md) by its
amendment in S2-00d. ADR-0109's side of SD5 and SD17 (the `start` message's `policy`, and no
secret in a forked environment) is recorded in
[ADR-0109](0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md)
by its amendment in S2-00c. None of those is decided here.

### SD1 — Tools are catalog connectors of kind `openapi` or `postgres`

SD1 (plan §8, slice 2): `openapiTool` and `postgresTool`
are catalog connectors of kind `openapi` or `postgres`. A version references them by name in
`resources.connectors`, as it does an `mcp()` connector, so the K-1 v1 version body shape and its
derived byte cap do not change. A tool is pinned per connector state, not per version (D21), until
N-1.

Contract fixed: **C15**. A tool connector is created with `kind: 'openapi'` (the document as text
up to 1 MiB, `baseUrl`, `allow` of `GET`/`HEAD` rules, a write-only credential) or
`kind: 'postgres'` (a write-only connection URL, `tables` 1–64, `readOnly: true`,
`maxRows` ≤ 1000). It is referenced by its connector name. The server never fetches a document,
because `aw` sends it. A connector without `kind` is `mcp`.

Reason: a connector already has a sealed credential (`credential_secret_id`), workspace
ownership, enablement and a name that versions reference. Reusing it gives tools all of that
without a new resource family, and leaves the version body, which slice 1 fixed, unchanged. The
cost is D21 (see "Declared gaps").

### SD2 — A tool runs in the gateway, behind a platform-hosted MCP endpoint

SD2 (plan §8, slice 2): a tool runs in the gateway behind
`POST <gateway>/v1/tools/<connectorId>/mcp`, a stateless streamable-HTTP MCP endpoint authenticated
by the run token. Compose gives every MCP-capable engine that URL as an `http` MCP server. D-2's
"inside the runner" becomes "inside the platform". The tool credential is never in the `RunRequest`
or in any process environment `aw dev` starts, so it never enters a sandbox on a sandboxing driver
(docker, sandbox-runtime). On the in-process `local` driver there is no sandbox
(`packages/runtime/src/local.ts:9-12`, `isolation: 'none'`, network `open`): an agent can read the
runtime's files and reach the API directly, so gateway egress and credential isolation are advisory
there. **The isolation claim holds on sandboxing drivers (docker, sandbox-runtime) only.**

Contract fixed: **C16**. Compose gives a tool connector to an engine only as this entry,
filled in after `gateway.issue`:

```ts
{
  type: 'http',
  url: '<gateway>/v1/tools/<connectorId>/mcp',
  headers: { authorization: 'Bearer <run token>' },
}
```

Nothing else credential-bearing for these kinds is in the `RunRequest`.
`runs.tool_connector_ids`, a new column (`uuid[] NOT NULL DEFAULT '{}'`, added by S2-02b's
migration in `packages/core`), records the set after the policy ceiling's meet (S2-04c),
so a connector the meet drops is never authorised. The gateway answers a tool call only when the
run is active, the connector is in `runs.tool_connector_ids` and in the run's workspace, and the
connector is enabled. It never decrypts the model key on this route and never meters it.

Reason: see "Context". The runner is inside the sandbox, the sandbox reaches only the gateway, and
the gateway already verifies the run token, reads the database and secrets, and has guarded
egress. Engines get an ordinary `http` MCP server, so no adapter's production code changes, and
`pi`, which has no MCP, is refused by the existing `422 engine_capability_unsupported`. D-2's
promise holds: the developer hosts no MCP server.

This is not the "tool executor" that
[ADR-0065](0065-an-agents-engine-is-an-extension-point-behind-one-port.md) D3 says the platform
never acquires. D3 refuses a platform-owned agent framework: a loop that decides which tool to
call, dispatches it, feeds the result back to the model, or emulates a tool feature an engine
lacks. SD2 adds none of that. The engine's own tool loop sees the endpoint as one more `http` MCP
server, as it sees a developer-hosted one, and decides, calls and consumes results itself; the
gateway only answers MCP requests for the connectors the run was composed with. An engine without
MCP gets no tools rather than a platform emulation (`pi`, see "Declared gaps"). ADR-0065 D3 is
therefore not amended.

### SD3 — `secret('NAME')` is a name only

SD3 (plan §8, slice 2): `secret('NAME')` (YAML:
`{ secret: NAME }`) is a name only. On `local`, `aw` reads the environment variable `NAME` and sends
its value only inside a connector or model-connection create or rotate request, which seals it as
today (`credential_secret_id`). No free-standing workspace secret is created.

Contract fixed: **C10**. YAML `{ secret: NAME }` and TS `secret('NAME')` are the same strict
object `{ secret: NAME }`, with `NAME` matching `^[A-Z][A-Z0-9_]{0,127}$`. The value is stored
only sealed under the gitignored `.agent-workspace/`: as the connector's or model connection's
`credential_secret_id` in the local runtime's database (`.agent-workspace/postgres`), sealed
under `MASTER_ENCRYPTION_KEY` from `.agent-workspace/local-secrets.json`. `aw dev` itself writes no
file holding the value and keeps only its SD16 fingerprint beside them. The value is never
logged, and is in the environment of no child `aw dev` forks (SD17). When the variable is
missing, `aw` prints `<NAME> is not set: run export <NAME>=… in the shell aw dev started from, then restart aw dev` (amended 2026-10-06 below), skips that
resource, and the save then reports `422 agent_definition_references_missing`. A string where a
reference belongs is refused at its path.

**Amendment (2026-10-06, [#755](https://github.com/indxjp/agent-workspace/issues/755)): the
Owner kept SD3.** Under `aw dev` a secret's value comes from `aw dev`'s own environment, and only
from there. A newly named `secret()` therefore needs an `export` and a restart of `aw dev`. Stored
secrets (`aw secrets create`) are not read by `aw dev`: they are write-only over HTTP,
`/api/secrets` is Owner-only and the local key is `admin` (ADR-0109). The `value missing` line
names both steps, with no value: `<NAME> is not set: run export <NAME>=… in the shell aw dev
started from, then restart aw dev`. `policy` stays a restart key for the same reason as the
secrets: the runtime reads it only in its `start` message, no API changes it, and a live path would
be a new runtime route; a save that changes it prints `agent-workspace.yaml: policy changed;
restart aw dev to apply` ([ADR-0109](0109-the-local-runtime-publishes-as-one-bundled-package-that-aw-dev-runs-from-the-project.md), SD17).

Reason: the sealed credential of a connector or a model connection already exists and is
write-only. A free-standing workspace secret would go through `/api/secrets`, which is
Owner-only, while the local key `aw dev` holds is `admin`; and §23 agent secrets are not wired
into runs at all (Declared gaps). A name in the file keeps the value out of git.

### SD4 — Slice 2 refuses write operations

SD4 (plan §8, slice 2): slice 2 refuses write operations.
`allow` names only `GET` and `HEAD`. `postgresTool` has `readOnly: true` as a literal and offers
only structured, parameterised reads, never free SQL. Any other request is a typed `422`, including
an `operationId:<id>` rule that names a write operation (`connector_write_unsupported`). MCP
connectors, which the project file can now declare (S2-01a), keep today's behaviour: their write
tools run without confirmation until the run-pause work lands, and `aw dev` prints this notice
whenever it applies one:

```text
connectors.<name>: MCP tools that write run without confirmation (ADR-0108)
```

Contract fixed: **C15** (`allow` of `GET`/`HEAD` rules, `readOnly: true`).

Reason: D30 says writes ask the end user to confirm. No run can pause anywhere in the platform,
and `openai-agents` refuses approvals (ADR-0065 D9). Rule 8 of the plan forbids accepting a write
and skipping the confirmation, so platform tools refuse writes instead. D30 is deferred and
recorded in
[ADR-0108](0108-the-frontend-is-a-four-rung-ladder-and-a-configuration-agent-edits-it.md)'s
"Slice 2 acceptance".

### SD13 — A tool connector's MCP server key is short

SD13 (plan §8, slice 2): a gateway tool connector's MCP
server key in the engine configuration is short, not `connector-<uuid>` (46 characters,
`resource-loader.ts:68-72`): the connector name lower-cased, every character outside `[a-z0-9_]`
replaced by `_`, prefixed with `t_` when it does not start with a letter, and cut to 16 characters.
On a collision within one run, connectors in id order get `_2`, `_3`, … within the same 16.
Amended by S2-02f (#531): runs of `_` collapse to one, a name starting with `_` takes the prefix
`t` rather than `t_`, and a trailing `_` is dropped after the cut, so a key never contains `__`
or ends in `_` and `mcp__<key>__<op>` splits in one place; the MCP server-name grammar admits a
single `_` between two other characters so the key parses. The model-visible worst case is Claude's `mcp__<key>__<op>`, so the operation-name cap is
64 − 5 − 16 − 2 = **41** characters. Existing MCP connectors keep `connector-<uuid>`, so their
entries stay byte-identical. *(Superseded for MCP connectors by the amendment below.)*

**Amendment (2026-10-14, [#1109](https://github.com/indxjp/agent-workspace/issues/1109)):
an MCP connector is keyed by its name when the name is a slug.** The install-live run 38379915671
(0.6.5, [#1021](https://github.com/indxjp/agent-workspace/issues/1021)) failed
excel-consolidation case 1 because the model mistyped one hex digit of the UUID in
`mcp__connector-<uuid>__find_files`. A key the developer wrote and can read is not mistyped that
way. An MCP connector's `mcpServers` key is therefore its connector name, verbatim, when all of
these hold, and `connector-<connectorId>` otherwise:

1. The name matches the project key grammar (`NAME_KEY_PATTERN`: lower-case `a-z0-9` and `-`, 1 to
   64 characters, no edge `-`). A project file's `connectors.<key>` becomes the connector's name,
   and names are unique in a workspace (`mcp_servers_workspace_name_key`), so two MCP connectors
   cannot take the same slug.
2. The name is at most 46 characters, the length of `connector-<uuid>`, so no tool name gets longer
   than it is today.
3. The name does not start with `connector-`, so it can never spell another connector's fallback
   key.
4. The name is not a key another component of the run owns: `agent-workspace`, the Claude
   adapter's skill-script server (`RESERVED_MCP_SERVER_KEYS`).
5. The name is not the SD13 key of a tool connector in the same run.

A collision is settled in one order, so a run composes the same keys every time: tool connector
keys are computed first and never change, and the MCP connector whose name collides (for example
MCP `orders` beside tool `Orders`, key `orders`) falls back to `connector-<id>`. A slug has no `_`,
so `mcp__<key>__<tool>` still splits in one place.

Only the key changes. Stored references (`agent_mcp_servers`, project associations,
`runs.tool_connector_ids`) and audit events stay keyed by the connector id; no migration is needed.
A stored policy rule written against the old form, `mcp__connector-<id>__…` in `tools.base`,
`tools.autoApprove` or `tools.deny`, keeps its meaning: compose rewrites the prefix to the run's
actual key for that connector, so a `deny` never stops matching. A rule may also be written in the
slug form, `mcp__<name>__…`, but it is stored by id: every policy save (the version pipeline, which
`PUT /api/agents/:id/policy` goes through too) rewrites a rule whose server is the name of an MCP
connector of the workspace to `mcp__connector-<id>__…`. A name is not stable, so a rule kept in the
slug form would stop matching when the connector is renamed or falls back to `connector-<id>` beside
a same-named tool connector, and an `autoApprove` would transfer to whichever connector next takes
the name. A slug-form rule naming no MCP connector of the workspace at save time (a tool
connector's key, or a connector not yet created) is stored as written and binds by name. A view
labels a stored `connector-<id>` rule with the connector's current key (`connectorNames` of the
policy response, the `engine_switch_would_widen` message, the Versions tab), and leaves a rule
whose key falls back to `connector-<id>` unlabelled; the stored value is unchanged. The withholding
arms (`openai-agents`, `pi`, `mastra`) store no tool names and need no rewrite. The policy
ceiling's `tools` allowlist names connectors, not keys, and is unaffected. A connector's key
changes when it is renamed or when a colliding tool connector joins or leaves the run; it is the
name a developer reads in the transcript.

Contract fixed: **C17**. The MCP tool name the gateway lists is the operation name: the
`operationId` sanitised to `^[A-Za-z0-9_-]{1,41}$`, else `<method>_<path>` sanitised and cut to
41. For `postgres` the names are `list_tables`, `describe` and `select`. Names are unique within a
connector (`422 connector_tool_name_collision` at registration). Compose keys each tool connector
by its SD13 short key. When a run's final names would still exceed 64 characters or collide
across connectors, compose refuses with the same code.

Reason: under the 46-character key an operation name gets 11 characters, which fits almost no
real `operationId`. A key derived from the name is also what the model and the developer read in
a transcript. Leaving existing MCP connectors on their key avoided changing any composed run that
existed then; the amendment above gives them the same readable key once the cost, a model-visible
rename, is worth paying.

### SD14 — `allow` globs match path templates segment by segment

SD14 (plan §8, slice 2): an `allow` path glob is matched
against the operation's path template, segment by segment: a template segment `{x}` is one segment,
`*` matches exactly one segment, `**` (last only) matches zero or more. `GET /orders/*` admits
`/orders/{orderId}` and not `/orders/{orderId}/items`. An `operationId:<id>` rule admits that
operation only if its method is `GET` or `HEAD`.

Contract fixed: **C15** (the `allow` rules) and **C17** (which operations become tools).

Reason: matching against the template, not a concrete URL, makes the allowed set a property of
the document that `aw check` and registration can compute once. A one-segment `*` keeps
`/orders/*` from silently admitting every sub-resource.

### SD15 — The base URL comes from `servers[0]` only when it is absolute

SD15 (plan §8, slice 2): without `baseUrl`, the base URL
is `servers[0].url` after substituting each server variable's `default`, and it must be absolute
`http` or `https`. A relative server URL, a variable without a default, or no `servers` is refused
with `422 connector_spec_invalid` naming `servers`.

Contract fixed: **C15** (`baseUrl`).

Reason: the server never fetches the document (C15), so it has no URL to resolve a relative
server against, and guessing one would send the credential to an unintended host.

### SD16 — `aw dev` records a fingerprint of each secret it sent, never the value

SD16 (plan §8, slice 2): `aw dev` keeps, in the
gitignored `.agent-workspace/`, an HMAC-SHA256 fingerprint of each secret value it sent (under a
random per-project key stored beside it), never the value. A changed fingerprint rotates that
credential on the next start, with a notice.

Contract fixed: **C11** (rotate a credential when `hasCredential` is false or when the secret's
fingerprint differs from the one recorded at the last send) and **C10**.

Reason: a credential is write-only on the server, so `aw dev` cannot compare the value it would
send with the one stored. Without a record, it must either rotate on every start or never notice
a changed token. A keyed fingerprint detects a change without keeping the value.

### SD17 — `aw dev` withholds every named secret from every child it forks

SD17 (plan §8, slice 2): `aw dev` withholds every
variable that a `secret()` or `{ secret: NAME }` names from every child it forks: the loader child
and the runtime it supervises (`packages/aw/src/local-runtime/supervisor.ts:110-113`
forwards the whole environment today).

Contract fixed: **C10** (the value is in the environment of no child `aw dev` forks).

Reason: on the `local` driver an agent runs as the runtime's process. A token in the runtime's
environment is one `env` read away, and SD2's claim that the credential is in no process
environment `aw dev` starts would be false. ADR-0109's supervisor contract is amended to match in
S2-00c.

## Declared gaps

- **Credential isolation on the `local` driver is advisory.** Fresh projects run on the
  in-process `local` driver: no sandbox, open network, the runner's own user. An agent allowed to
  run commands can read files under the project, including the local runtime's database
  (`.agent-workspace/postgres`, with each sealed `credential_secret_id`) and the key that seals
  it (`.agent-workspace/local-secrets.json`), and can reach the upstream API without the
  gateway's egress guard. "The token never enters the sandbox" holds on sandboxing drivers
  (docker, sandbox-runtime) only. `aw dev` still keeps every `secret()` value out of every
  child's environment (SD17).
- **Tool versions (D21) are deferred in slice 2.** A tool is pinned per connector state, not per
  version: editing a tool connector changes every version that references it, until N-1.
- **Confirmation on writes (D30) is deferred.** Platform tools refuse write operations (SD4). MCP
  connectors run their write tools without confirmation, as today, with `aw dev`'s notice. See
  [ADR-0108](0108-the-frontend-is-a-four-rung-ladder-and-a-configuration-agent-edits-it.md).
- **Egress to private hosts.** A tool's base URL or database host on a private address is
  reachable only through the global `EGRESS_ALLOW_HOSTS`. Approving a host per connector belongs
  with the catalog (T-3). On Cloud Run, the gateway's VPC egress is the operator's concern.
- **`pi` gets no tools.** It has no MCP, so a tool connector on `pi` is refused with
  `422 engine_capability_unsupported` (ADR-0065 D3).
- **OpenAPI subset.** Accepted: 3.0 and 3.1, JSON or YAML, internal `#/` `$ref` only, at most 128
  operations, parameter styles `simple` and `form`. Anything else is refused by name.
- **Existing MCP connectors put their decrypted credential into the `RunRequest`**
  (`apps/web/server/compose/resource-loader.ts:266-282`): filed as
  [#552](https://github.com/indxjp/agent-workspace/issues/552). Slice 2 does not fix it,
  and tool connectors do not repeat it (C16).
- **§23 agent secrets are never wired into run composition**
  (`apps/web/server/composition/register.ts:1132-1137`, an empty `{}` secrets map): filed as
  [#553](https://github.com/indxjp/agent-workspace/issues/553). Slice 2 does not use them
  (SD3), and tool connectors do not depend on them (C16).

## Consequences

- D-2's promise holds with no self-hosted MCP server, and it reads "inside the platform" rather
  than "inside the runner"
  (the developer-journey document).
- No engine adapter's production code changes. Every MCP-capable engine receives a tool connector
  as one more `http` MCP server; `pi` is refused by an existing code.
- The gateway gains a second responsibility next to model proxying: serving tools. It must
  authorise each call against `runs.tool_connector_ids`, the run's workspace and the connector's
  enablement (C16), and it must not meter tool calls as model usage.
- Contracts gain the `openapi` and `postgres` connector kinds and the `{ secret: NAME }` reference
  (C10, C15). A connector without `kind` stays `mcp`, so existing rows and requests are unchanged.
- A tool's operation names are capped at 41 characters (C17). An MCP connector's server key is its
  slug name, or `connector-<uuid>` when the name is not a usable slug (SD13, amended by #1109), so
  the model-visible tool names of slug-named MCP connectors change, and anything that matched
  `mcp__connector-<uuid>__…` exactly (an eval `tool:` matcher, a surface `toolResults` key, a trace
  reader) must use the new form.
- `aw dev` gains a small sealed state per project under `.agent-workspace/` (SD16) and filters
  its children's environments (SD17). A changed token needs an `aw dev` restart.
- Slice 2 ships read-only tools. Writes wait for the run-pause work that D30 needs.

## Alternatives rejected

- **Native in-runner tools on four adapters.** Each engine adapter would implement `openapi` and
  `postgres` tools itself. The plan costed this at 8–10 PRs across four adapters plus a new
  capability key, and it puts the credential and an open egress path inside the sandbox, which
  breaks the rule that only the per-run token enters it.
- **The developer hosts an MCP server.** It works today with an `mcp()` connector, but it breaks
  D-2's promise, which is the point of `openapiTool` and `postgresTool`.
- **The tool credential in the `RunRequest`, as MCP connectors do today.** It would make the
  tools work with no gateway change, but it repeats the defect filed as #552 and puts the
  credential in the sandbox.
- **A free-standing workspace secret through `/api/secrets`.** Those routes are Owner-only, while
  the local key `aw dev` holds is `admin`, and §23 secrets do not reach runs (#553). Sealing the
  value into the connector's own credential needs neither.
- **Keying tool servers `connector-<uuid>`, as MCP connectors are.** It leaves at most
  64 − 5 − 46 − 2 = 11 characters for an operation name (SD13).
- **Sanitising every MCP connector name like SD13's `toolServerKey` (#1109).** It would change the
  key of names that are not slugs, need ordinal suffixes across MCP connectors, and make the key
  differ from the project key a developer wrote. The slug verbatim, or the UUID, is predictable.
- **Renumbering the tool connector on a collision with an MCP slug (#1109).** It would change SD13
  keys that are published and pinned in tests. The MCP connector is the one that falls back.
- **Rewriting stored policy rules in a migration (#1109).** The key depends on the run (a colliding
  tool connector), so a stored rewrite can be wrong; compose-time rewriting is exact.
