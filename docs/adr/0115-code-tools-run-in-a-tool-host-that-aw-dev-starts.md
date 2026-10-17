# ADR-0115 — Code tools run in a tool host that `aw dev` starts

Status: accepted
Date: 2026-10-05
Decided by: the product owner, on the first-hour plan (decision D48, issue #693, tracker #687); the gate exception below on the Owner's explicit approval
Scope: `packages/aw` (`src/tools/host.ts`, `src/tools/host-child.ts`, `aw dev`), `packages/core/src/db/repositories/database-reachability.test.ts` (one named exception); amends ADR-0113; amended by ADR-0118

## Context

ADR-0113 made a tool defined in code a catalog connector that runs in the gateway. A tool
declared with `defineTool` has a `run` file of the developer's own, with full Node, the project's
`node_modules` and its environment. The gateway cannot import that, and the closed module linker
of ADR-0111 would refuse what such a file needs. A developer needs the tool to work in the first
hour, on their own machine, before any deployment hosts tools.

## Decision

**D48. Code tools run in a tool host that `aw dev` starts. It is local only.**

- `aw dev` starts the tool host as a child process, serving the project's code tools over MCP
  Streamable HTTP on `127.0.0.1:<port>/<token>/mcp`, and stops it with the runtime.
- **Pushing a code tool to a non-local environment is refused by name** until tools are hosted in
  deployments. The refusal says which tool and why; it never uploads a tool it cannot run.
  ADR-0118 decides how deployments host tools and when this refusal lifts.
- **Exposure.** The host listens on loopback only. The only credential is an unguessable path
  token, fresh per `aw dev`; a process on the same machine that learns the URL can call the
  tools, as it could run the developer's files itself.
- **The child inherits the developer's environment.** It is the developer's own code, run as
  `node tools/x.ts` would run it, so it sees their environment, including any token they
  exported. This differs from definition loading (ADR-0111), where nothing but the define module
  is linked.
- **The computed import is decided.** The host imports each run file by its real path, so the
  specifier is a run-time value and cannot be a literal. The reachability gate
  (`database-reachability.test.ts`) throws on any such import (ADR-0027 clause 3, ADR-0031).
  The gate now holds one decided exception: the exact path `packages/aw/src/tools/host-child.ts`,
  for dynamic imports only, with that reason. It is not a glob and not a suppression; every other
  file keeps the rule, and an assertion pins the list to this one entry. The run file is checked
  to stay inside the project once symlinks are followed, and a project cannot name the database
  layer, which ADR-0015 forbids.
- **Amends ADR-0113.** Its statement that tools defined in code run in the gateway holds for
  declarative connectors (`openapiTool`, `postgresTool`). A `defineTool` code tool runs in this
  host, locally.

## Consequences

- A developer's code tools work in `aw dev` with no deployment.
- Code tools do not work in a deployment yet; the refusal is explicit rather than a silent drop.
  ADR-0118 decides the per-session tool sandbox that lifts it.
- The gate has one reviewed, named exception; adding another needs a change to this ADR.

## Alternatives rejected

- **Run it in the gateway or runner.** Breaks ADR-0113's reasons: the sandbox must hold only the
  per-run token.
- **Load it through the closed linker.** The run file needs real Node capabilities.
- **Hide the import from the gate** (for example with `new Function`). It reaches the same module
  and evades the check; a named, decided exception is reviewable.
