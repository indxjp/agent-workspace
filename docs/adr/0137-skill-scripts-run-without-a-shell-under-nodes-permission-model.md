# ADR-0137 — Skill scripts run without a shell, under Node's permission model

Status: accepted
Date: 2026-10-12
Decided by: issue #1089, the decision in its body (orchestrator); amends ADR-0074 and ADR-0081
Scope: `packages/engine/src/skill-script.ts`, the `skill-script.ts` host in each of `packages/engine-claude-agent-sdk`, `packages/engine-mastra` and `packages/engine-openai-agents`, their `boundary.ts`/`compile.ts`/`tools.ts` wiring, `tests/engine/`, `tests/gallery/`

## Context

A read-only `files()` grant withholds the shell on every engine: `claudeFileGrantDenials` denies
`Bash`, `BashOutput` and `KillShell`; `permissionToolPlan` drops every `runCommands` tool for Mastra
and OpenAI Agents (ADR-0074, ADR-0081). The rule is sound. With a shell, a redirect writes through
a read-only grant, and no guard can tell a redirect from a read.

The cost is an agent that reads documents through its **skill scripts**. Its scripts are Node files
under the placed skill directory and run as `node scripts/x.mjs …` through the shell, so the agent
loses them as soon as its documents are a read-only grant. contract-review, quality-defect,
cad-drafting and meeting-minutes fail live this way (install-live run 38243507901, #1021), and #1087
recorded the gap in the gallery (`SHELL_WITHHELD`, the `shell-with-read-only-grant` probe).

What the platform needs is not a shell with fewer rights. It is a way to run **one named file the
tenant shipped with a skill**, with arguments, whose writes the operating system's process owner
cannot widen.

## Decision

Add one engine-portable tool, `run_skill_script { skill, script, args[] }`, defined in
`packages/engine` next to `skillsUnderConfigDirectory`. `Bash` stays denied under a read-only grant,
so `claudeFileGrantDenials`, `applyFileGrantPolicy` and `EngineToolPolicy.lean` are unchanged.

- **When it is offered.** Only when the agent has `runCommands` on **and** a granted skill ships at
  least one file under `scripts/`. Both `runCommands` and the skill grant are the author's choices;
  the tool adds no new permission, it is the one use of `runCommands` that a read-only grant leaves
  standing.
- **How it runs.** `execFile(process.execPath, ['--permission', '--allow-fs-read=<cwd>',
  '--allow-fs-write=<writable>', <placed script>, ...args], { cwd, timeout, maxBuffer, env })`.
  There is no shell, so there is no redirect, pipe, glob or variable expansion. `<writable>` is the
  run's per-call temporary directory and, only when `writeFiles` is on, each read-write grant. A
  read-only grant is therefore readable (it is inside `cwd`) and never writable: Node refuses the
  write with `ERR_ACCESS_DENIED` in the process itself, whatever the script does.
- **What the script may name.** `skill` must be a granted skill that ships at least one file under
  `scripts/`; `script` must be one plain file name (empty, NUL and over-255-byte names are
  `unusable_script`; a name with `/`, `\` or `..` is `outside_skill_directory`). The granted file
  list is not consulted per call: what decides is that the real path of the placed file
  (`realpath`, symbolic links resolved) lies inside the real
  `<cwd>/<config>/skills/<skill>/scripts/`. At most 64 arguments of at most 8 KiB each.
- **Limits.** 120 s wall clock (the OpenAI shell's timeout) and 1 MiB per stream (stdout, stderr). The
  environment holds only `TMPDIR`: a script gets no variable of the run, so no gateway token reaches it.
- **Named refusals.** `unknown_skill`, `unusable_script`, `outside_skill_directory`, `timeout`,
  `output_too_large`, `unusable_arguments`. A script that exits non-zero is **not** a refusal: the
  exit code, stdout and stderr go back to the model, which is how a script reports "this file has
  no such clause".
- **Engines.** The Claude Agent SDK adapter registers it as an in-process MCP server named
  `agent-workspace` (the tool is `mcp__agent-workspace__run_skill_script`, and a connector may not
  take that server name); the Mastra and OpenAI Agents adapters add it to the agent's tool record.
  The decision logic is `packages/engine`'s; each adapter supplies a ten-line Node host
  (`execFile`, `realpath`, `mkdtemp`, `rm`). `packages/engine` keeps depending on contracts alone.
- **Approval.** The adapters do not pre-approve the tool. On Claude the author lists
  `mcp__agent-workspace__run_skill_script` in the agent's `autoApprove`, the way `Bash` was listed
  before; Mastra and OpenAI Agents have no approval step. Their adapters throw when the call is a
  refusal or a non-zero exit, so the engine marks the tool call as failed and the model sees the text.

### Threat model

| Threat | What stops it |
| --- | --- |
| A path escape in `script` (`..`, `/`, an absolute path) | The name is one plain file name from the skill's own file list; a separator or `..` is `outside_skill_directory`, an empty, NUL or over-long name is `unusable_script`, before any file is touched. |
| A symbolic link at the script's path | The real `scripts/` directory must be the placed `<cwd>/<config>/skills/<skill>/scripts` itself, and the real path of the script must be inside it, or the call is `outside_skill_directory`. The runner already refuses to place a link; this is the independent second check. |
| A write through a read-only grant | `--allow-fs-write` never names a read-only grant. Verified on Node 24.21 with a real process: the write, a rename out of the grant, and a hard link or new symbolic link into a writable path are all `ERR_ACCESS_DENIED`. |
| A script that starts a program or worker | The permission model denies `child_process`, workers and native addons. The shell is not reachable through the script. |
| A symbolic or hard link that **already exists** inside a writable grant and points at a read-only file | **Accepted residual risk.** Node follows it, and a write through it succeeds (pinned by canary tests in `tests/engine/run-skill-script.test.ts`, so a Node change that closes it shows up). The script cannot create such a link (new links are `ERR_ACCESS_DENIED`) and the runner refuses to place one; it can only exist if the tenant uploaded it. A bounded scan of the writable grants for links before the call is possible hardening, not done here. |
| Unbounded output | Each of stdout and stderr is capped at 1 MiB; over it the process is killed and the call is `output_too_large`. |
| A script that never ends | 120 s, then SIGKILL; the call is `timeout`. |
| A SIGTERM-trapping script | Every kill — timeout, output cap, the run's abort — is SIGKILL, which a script cannot trap. |
| Network access | The permission model does not restrict the network. The script inherits the sandbox's network-level enforcement (`none` is an internal network; `restricted` and `open` go through the egress proxy). Its environment has no proxy variables, so proxied egress fails closed. It gets no access beyond what Bash had. |
| Environment secrets | The child's environment holds only `TMPDIR`. |

The permission model is a guard against the model, not a sandbox against hostile tenant code: the
script is tenant content, it runs with the runtime image's Node, and it can read the whole run
directory (including the engine's configuration directory), as the file tools already can. The
runtime driver remains the isolation boundary.

`--permission` is the stable flag name from Node 24, which is the minimum the repository already
pins (`engines.node >=24`, runtime image `node:24.21.0`), so no pin changes. Node 22 spells it
`--experimental-permission`; below 24 the process refuses to start and the call fails loudly
rather than running unguarded, and no fallback flag is added.

## Alternatives considered

- **A scratch write grant** so the shell could be allowed. Any read-only grant still withholds
  `Bash`; the rule would have to change, and with it the formal theorem.
- **The Claude SDK sandbox.** Claude-only and dependent on the driver; the other engines gain nothing.
- **Prefix `Bash(node …)` allow rules.** The bare deny wins, and a redirect is still possible
  inside a prefix-allowed command.
- **An executor package (`packages/engine-node`) or `@types/node` in the port.** A new layer for ten
  lines per adapter, and it breaks `engine-port-depends-only-on-contracts`.
- **Stdin for the script.** The decision fixes `args[]`. The two gallery scripts that read stdin
  take a file or an argument instead.

## Consequences

- An agent with a read-only grant, `runCommands` and skills can run its scripts again. Nothing about
  `Bash` changes, and the formal tool-policy vectors are untouched.
- Scripts must be Node files, take their input as arguments and files, and finish within 120 s and
  1 MiB per stream. A Python or shell script is not supported.
- OpenAI Agents declares `skills: false` and refuses granted skills at compile, so the tool is
  wired and tested there but cannot be offered until skills are enabled for that engine. pi also
  withholds its shell and has no tool yet. Both are follow-ups.
- The tool is additive: reverting it restores the previous behaviour, with the gallery cells back
  to `gap`.
