# ADR-0118 — Code tools and stdio MCP servers run in a per-session tool sandbox in deployments

Status: accepted
Date: 2026-10-07
Decided by: the product owner, on the build → deploy programme (issue #788, tracker #780)
Implementer defaults (orchestrator-accepted, 2026-10-07): the tool sandbox is reused across a session's runs with a fresh token per run; stdio servers get no implicit package-registry egress; field names are left to B2b/B3; B3 decides whether host-child.ts is reused or moved.
Scope: `packages/aw` (`aw push`, `src/tools/host-child.ts`), `packages/runtime` (a second `create()` per session), `apps/runner` (token, secret injection), `apps/web` (the `code_tool_needs_host` refusal), `packages/core/src/db/repositories/database-reachability.test.ts` (the one named exception, only if it moves); amends ADR-0115

## Context

ADR-0115 runs a `defineTool` code tool in a tool host that `aw dev` starts, on the developer's
machine only. It refuses to push such a tool to a non-local environment, so an agent with a real
tool cannot reach production: `aw promote` answers `422 code_tool_needs_host`. A `stdio` MCP
connector is stored (`transport = 'stdio'`, `command`, `args`) but nothing launches it.

Both need the same thing: a place in a deployment to run developer code that is not the agent
sandbox and not the gateway. The agent sandbox runs model-driven code and must hold only its own
per-run token (ADR-0113). The gateway is shared by every tenant and must not execute a tenant's
files (ADR-0113, ADR-0115). This ADR decides that place. It decides what and where, not the API
shapes; the units named in each clause own those.

The clauses are named `TS1`–`TS9` (tool sandbox) so they cannot be confused with the `SD` clauses
of ADR-0113. A later unit cites one of them.

## Decision

**In a deployment, code tools and `stdio` MCP servers run in a per-session tool sandbox. The
gateway reaches it over MCP Streamable HTTP with a per-run token.**

### TS1 — Bundle (B2b)

- `aw push` bundles the run file of each code tool into one ESM file with the esbuild already in the
  repository (no new dependency). Node built-ins stay external; bare imports of the project's own
  dependencies are bundled in.
- The bundle is stored content-addressed by its SHA-256, and the agent version records that hash. A
  version therefore pins the exact tool code it was saved with, and a rollback to an earlier version
  also rolls back the tool.
- A dependency that needs a native addon is refused at push time, by tool and package name. It is
  never uploaded and never fails later at run time.
- The platform stores the bundle and owns the version (ADR-0101); the sandbox never installs
  packages and never reads the developer's source tree.

### TS2 — Placement (B3)

- The tool sandbox is **per session**. It is created with `RuntimeDriver.create()` on the same
  driver as the agent sandbox, as a second, separate runtime, and destroyed with the session. It is
  not a new driver type and not a new driver method.
- It never runs inside the agent sandbox, never inside the gateway, and never in the control plane.
- One tool sandbox serves every run of its session. A run does not get a new sandbox; it gets a new
  token (TS3).

### TS3 — Reachability (B3)

- The tool sandbox serves the project's tools over MCP Streamable HTTP, the protocol ADR-0115's
  host already speaks. The gateway is the only caller. The agent sandbox does not reach it, and
  still holds only its own per-run gateway token (ADR-0113).
- The runner mints a per-run token when it starts a run and gives it to the gateway for the run's
  lifetime. The tool sandbox accepts only the tokens of its session's live runs; each is revoked
  when its run ends. The token is a credential in a header, not a path segment as in the loopback `aw dev` host.
- A tool the run was not composed with is not callable, as in ADR-0113.

### TS4 — Environment (B3)

- The tool sandbox starts with **no inherited environment**. It receives exactly the union of the
  secrets declared with `secret('NAME')` (ADR-0113 C10) by the session's code tools and stdio MCP
  servers, and nothing else of the platform's own.
- The runner resolves each declared name from the sealed secret store of the session's workspace
  and injects it when it starts the sandbox. A declared name with no stored value fails that tool's
  start with a typed error naming the secret, never its value. Neither the control plane's own
  variables, the agent sandbox's run token, nor another session's secrets are passed. Isolation is
  per session: per-tool isolation inside one session is out of scope and may be revisited later.
- Whether a tool declares its secrets as a field on `defineTool` or by inference from its
  references is for B2b/B3 to decide. The principle is fixed: declared, by name, injected by the
  runner.
- This is the opposite of ADR-0115's local host, which inherits the developer's environment. That
  is acceptable locally, where the code and the secrets are the developer's own; it is not
  acceptable where a tenant's code runs next to a platform.

### TS5 — Egress (B3; depends on A1 #781 and A4 #784)

- The tool sandbox's only route out is the egress allowlist proxy of unit A1 (#781). The allowlist
  is the union of the domains declared by the session's code tools and stdio MCP servers. A session
  that declares none has no egress.
- The sandbox has no other route: not the cloud metadata address, not the host or cluster network.
  How each driver enforces that is A1's and A4's decision, not this ADR's.
- The tool sandbox accepts inbound traffic from the gateway only (TS3).

### TS6 — `stdio` MCP servers (B5)

- A `stdio` MCP server is launched inside the same per-session tool sandbox and exposed behind the
  same MCP Streamable HTTP front, so the gateway has one way to reach tools. It gets the same
  environment (TS4) and the same egress (TS5) rules.
- It runs from what the sandbox image or the stored bundle already contains. The registry is not
  allowed implicitly: a command such as `npx -y <package>` that must fetch at start works only if
  the connector declares the registry domain like any other egress, and it is not reproducible. B5
  decides how a package is provided ahead of time.

### TS7 — `aw dev` is unchanged

- `aw dev` keeps ADR-0115's local host: a child process on `127.0.0.1:<port>/<token>/mcp`, a fresh
  path token, the developer's inherited environment. TS1–TS6 do not apply to it, and it needs no
  deployment, bundle or sandbox.

### TS8 — The refusal is lifted for a bundled version (B4)

- `code_tool_needs_host` (`422`) no longer means "code tools do not run in deployments". It stays
  for a version that has a code tool but no recorded bundle hash, because that version has nothing
  to run.
- A version whose code tools all have a bundle hash can be promoted. Promote and rollback move the
  pinned hash with the version (TS1).
- The refusal lifts only when the target environment's runner can start a tool sandbox; an
  environment that cannot is still refused by name.

### TS9 — The reachability gate

- The gate (`database-reachability.test.ts`, ADR-0027 clause 3, ADR-0031) throws on any computed
  import. It holds one decided exception, `packages/aw/src/tools/host-child.ts`, pinned by an
  assertion to exactly that entry (ADR-0115).
- The hosted runtime serves the bundle from TS1, which is a file the sandbox imports by path, so it
  needs the same kind of import. If it **reuses `host-child.ts` from `packages/aw`** (carried into
  the sandbox image), the gate does not change.
- If it **moves or copies** that code to another path, the exception moves to that exact new path:
  still one entry, still exact, not a glob, not a suppression, with the reason citing this ADR. The
  assertion keeps pinning the list to one entry. A second entry, or a path that is not the host's
  own, needs a further change to this ADR.
- The tool sandbox also never contains the database layer; a bundle that names it is refused, as in
  ADR-0115 (ADR-0015).

### Unit → clause

| Unit | Clause |
| --- | --- |
| B2b #790 — bundle at `aw push`, stored with the version | TS1 |
| B3 #791 — hosted tool sandbox | TS2, TS3, TS4, TS5 |
| B4 #792 — promote and roll back with code tools | TS8 |
| B5 #793 — `stdio` MCP connectors in the tool sandbox | TS6 |
| Any move of `host-child.ts` | TS9 |

### Relation to earlier ADRs

- **Amends ADR-0115.** Its refusal to push a code tool to a non-local environment holds until the
  clauses above are implemented, and then holds only as TS8 says. Its local host is TS7.
- **Amends ADR-0113 SD2 for hosted code tools.** The statement that a tool runs in the gateway
  stays true for declarative connectors (`openapiTool`, `postgresTool`). A `defineTool` code tool,
  and a `stdio` server, run in the tool sandbox.
- **ADR-0113 SD3 holds.** `secret('NAME')` is still a name only in the definition. Its value is
  resolved by the runner from the sealed store, never read from the developer's shell in a
  deployment.

## Consequences

- An agent with a code tool can be promoted, run and rolled back in a deployment, and `stdio`
  connectors can run, once B2b, B3, B4 and B5 land. Until then the refusal of ADR-0115 stands.
- A session costs one more runtime. A session that uses no code tool and no `stdio` server does not
  start a tool sandbox.
- The tool code is the developer's, the sandbox holds only the secrets the session's tools and
  servers name, and its only route out is the allowlist proxy. A compromised tool can reach
  everything declared within its own session, never the platform's secrets, the agent sandbox's run
  token, or another session's.
- The reachability gate keeps one exception, at an exact path. Where the hosted runtime lives is a
  reviewed choice (TS9); a second hidden import path is not available.
- Egress and isolation depend on unit A1 and on A4 for each driver. Until a driver enforces the
  allowlist, B3 must refuse to start a tool sandbox on it rather than run one with open egress.
- The tool sandbox's behaviour is fixed by the driver's isolation. A driver with `isolation: 'none'`
  (the in-process `local` driver, ADR-0113) gives no boundary, so it keeps ADR-0115's local host
  and does not host tools under this ADR.
- If this is reversed, ADR-0115 is back in force and every environment refuses code tools again.

## Alternatives rejected

- **Run tools inside the agent sandbox.** The model's code would run next to the tool's secrets and
  could read them. ADR-0113 keeps the agent sandbox to its own per-run token.
- **Run them in the gateway, in an in-process `vm` or isolate.** Breaks ADR-0113's and ADR-0115's
  reasons: the gateway is shared, and a run file needs full Node and the project's dependencies.
- **A shared, long-lived tool service per workspace.** It needs isolation between sessions and
  would not version with the agent: a rollback could not roll the tool back.
- **Upload the source tree and install at start.** Slow, not reproducible, and needs registry
  egress, which TS5 withholds.
- **Pass the developer's whole environment, as `aw dev` does.** It leaks every secret of the
  platform into tenant code. TS4 injects only what the session's tools name.
- **Rewrite ADR-0115 in place.** An accepted ADR is a record; this one amends it and 0115 points
  here.
- **Two ADRs, one for code tools and one for `stdio` servers.** Both share one sandbox, one front
  and one environment rule; deciding them apart would let them drift.

## Amendment (2026-10-08)

Issue #847 (code tools end to end in a deployment) implements TS3 and TS4 with two deviations,
accepted by the orchestrator:

- **TS3 — who mints the tool sandbox's token.** The runner does not mint it. The web service
  derives it as HMAC-SHA256(gateway signing secret, run id), domain-separated from the run token,
  and hands it to the runner with the allocation; the gateway recomputes it on every request
  instead of being given it. The token still never enters the run request, so the agent sandbox
  never holds it.
- **TS4 — who resolves the declared secrets.** The runner does not read the sealed store. The web
  service resolves each declared name from the workspace's secrets and sends the values to the
  runner manager, a trusted internal service, which injects them into the tool sandbox through its
  stdin manifest. They never reach the agent sandbox, and a name with no stored value still fails
  the run with a typed error naming the secret, never its value.
