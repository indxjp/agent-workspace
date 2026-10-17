# W1-COMP-01 — The runner supplies the run's base environment, and creates the workspace it was told to use

Status: accepted
Date: 2026-09-03
Decided by: W1-COMP-01 (the composition root)
Scope: `apps/runner/src/index.ts`; `Dockerfile` (`runner` target), `runtime.Dockerfile` (both
`CMD`s); consequences for `apps/web/server/compose/run-request.ts`

## Context

R-01 §3's first trap is that the Agent SDK's `options.env` **replaces** the subprocess
environment rather than merging with it — a breaking change in SDK 0.2.113.
`packages/core/src/schemas.ts` records the trap and states who owes the remedy:

> That makes this field the complete environment, and it makes the runner — not this schema —
> responsible for spreading whatever the subprocess still needs (`PATH`, `HOME`, credentials).

Nothing discharged that sentence. `compileRunRequest` builds `{ ...parsed.env, <session scope> }`,
`claude.ts` hands it to the SDK as `options.env`, and the runner had no entry point at all — both
Dockerfiles started `startRunnerServer()` from an inline `node -e`, which is
[W1-INF-01's declared smell](W1-INF-01-the-runner-has-no-committed-entry-point.md) and whose
record ends by asking the first task to touch `apps/runner/src/index.ts` to remove it.

So the first end-to-end run this repository has ever attempted failed, and the two ways it failed
are the two decisions below. Both were measured against a real `apps/runner` started by
`pnpm --filter @agent-workspace/runner start`.

A well-formed `RunRequest` whose `env` was `{}`:

```text
event: run-failed
data: {… "message":"Claude Code native binary at …\\claude.exe exists but failed to launch."}
```

The same request with an environment spread into it:

```text
event: system
data: {"kind":"system","subtype":"init","cwd":"…","apiKeySource":"none", …}
event: sdk-event
data: {… "content":[{"type":"text","text":"Not logged in · Please run /login"}] …}
```

## Decision

**`apps/runner/src/index.ts` is a real entry point, and the `startAgent` it passes to
`startRunnerServer` does two things the SDK boundary cannot do for itself.**

**1. It spreads the container's own environment under the request's.** `runnerBaseEnvironment()`
copies `process.env`, drops undefined values and empty names, and removes `CLAUDE_CONFIG_DIR` and
`CLAUDE_CODE_PROJECT_DIR_NAME` — the two `compileRunRequest` derives from the tenant session scope
and that `RunEnvironment` refuses to let a body set, because R-01 §7 makes a second source for
either a silent cross-tenant session collision. The request's own `env` is applied last and wins.

It is the whole environment, not a curated list. A list would be this file inventing a policy
about which of a deployment's variables a run may see and being quietly wrong in both directions:
a missing `SystemRoot` on Windows or `LD_LIBRARY_PATH` on Linux is a spawn failure with an
unhelpful message, and a name added "because something needed it" is a name nobody removes.

Amended 2026-10-12 (#1021): the base is a short allow-list, not the whole environment, and not
empty. `724bfa6e` ("run-scoped authentication") made `runnerBaseEnvironment()` return `{}` so that no
deployment variable, provider key included, reaches a run. That also removed `PATH`: the SDK
replaces the subprocess environment, so every `Bash` command ran with bash's built-in default path,
and a `node` installed by nvm, volta, fnm, Homebrew or a CI toolchain cache was not found (the
`quotation` use case reported "Node.js is not available" while its policy did allow `Bash`). The
function now copies only `PATH` and `HOME` on POSIX, and `PATH`, `USERPROFILE`, `SystemRoot` and
`TEMP` on win32, when the container defines them: the keys `apps/web/server/connectors/base-env.ts`
already gives a spawned connector command. This narrows the "curated allowlist" rejected below to
the operating system's minimum to start a program; the request's own `env` still wins.
`CLAUDE_CONFIG_DIR` is set per session, so `HOME` does not make a run read the host's `~/.claude`.

**2. It creates the `cwd` and the config directory it was told to use.** §14.3's body chooses the
run's `cwd`, and in every deployment except `local` the control plane that chose it shares no
filesystem with the container that must chdir into it. `mkdirSync(…, { recursive: true })` is
idempotent, which is what a second run in the same workspace needs. `Dockerfile`'s `runner` target
now creates `/workspace` owned by `node`, which `runtime.Dockerfile` already did and already
described as *"the SDK's `cwd` for a run and the only path in the image the process is expected to
write to"*.

**Both `CMD`s become `node dist/index.js`.** That is the end state W1-INF-01's record asks for,
and it is now load-bearing rather than cosmetic: a container started by the old inline command
would serve `POST /run` and fail every run, because neither of the two things above would happen.

## What this changes about credentials, stated precisely

`.env.example` says, of `ANTHROPIC_API_KEY`:

> in this build there is no configured path from an operator's provider key to a run at all

That sentence is still true and this record is why it needs the word *configured*. Neither
`.env.example` nor `compose.yaml` puts a provider credential into the runner's environment, and
`apps/web/server/compose/run-request.ts` sends `env: {}` because spec A.11 forbids a provider
master credential entering a sandbox — the model gateway of §26 injects a short-lived run-scoped
token, it is Wave 4, and `compose.yaml` runs a placeholder that refuses every request. What has
changed is that an operator who *does* put a credential in the runner container's environment has
now given it to every run on that container. That is a real consequence of a decision taken here,
it is not hidden behind an empty object, and it is on this task's PR as a declared gap.

## Honest downside

**A run can read every environment variable the runner container was started with.** That is the
pre-0.2.113 default behaviour of the SDK and it matches `local`'s declared `isolation: 'none'`
(§14.5), but it is a wider surface than `env: {}` and it is chosen rather than inherited. The
bound is the one `apps/runner/src/server.ts` already states: the socket has no authentication and
is reachable only by its driver on a private network. A deployment that exposes it has a much
larger problem than this variable list.

**A caller of `POST /run` can create a directory anywhere the runner's user can write.** Not a new
capability — `local` declares `execCommands` and `isolation: 'none'`, so the same caller can
already run a command as that user — but it is one more thing bounded only by the network.

**Per-workspace isolation is a directory, not a boundary.** `${RUNNER_WORKSPACE_ROOT}/<workspace
id>` gives each tenant a distinct `cwd` and a distinct `CLAUDE_CODE_PROJECT_DIR_NAME`, which is
what §25 asks for and what stops two tenants sharing one session key namespace. It does not stop a
run reading a sibling directory, because nothing in Wave 1 does: §15.4's advanced isolation and
§15.3's filesystem policy are later waves. Declared.

## Alternatives rejected

* **Merge in `claude.ts` or `compileRunRequest`.** It is where the merge is easiest and it is the
  wrong place: `RunEnvironment`'s contract is that the body carries the *complete* environment, and
  a merge underneath it would make the field mean something different from what it says while
  leaving the schema's own note pointing at the runner.
* **Have the control plane send `PATH`, `HOME` and the rest.** The web application does not know
  the runtime container's filesystem, cannot know it for a driver it does not own, and would be
  hard-coding one image's layout into a tenant's run request.
* **A curated allowlist of variable names.** Rejected above: wrong in both directions, quietly.
* **Leave `env: {}` and declare the run path unbuilt.** The task's acceptance criterion is a run
  that reaches the runner and streams back. Declaring it unbuilt when two small, correct changes
  in this task's own file make it work would be reporting a gap instead of closing one.
