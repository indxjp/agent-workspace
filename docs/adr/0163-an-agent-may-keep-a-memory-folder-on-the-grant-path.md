# ADR-0163 — An agent may keep a memory folder on the grant path

Status: accepted
Date: 2026-11-01
Decided by: the implementing agent of U5.5b (issue #1526, agent portal programme, tracker #1476), on the Owner's delegation for the programme, building the option the U5.5a spike (#1525) recommended and the Owner's recorded default O-3 (#1479: "no platform memory resource; engine-native memory and files-as-memory only")
Scope: `packages/contracts` (`agents/permissions.ts`: `AgentPermissions.memory` and the memory constants; `observability.ts`: the audit action `memory-updated`), `packages/sdk` (`defineAgent` `permissions.memory`), `apps/web/server/compose` (the resource loader, compose, the workspace lifecycle), `apps/web/server/runs/launcher.ts`, `packages/engine-claude-agent-sdk/src/compile.ts`, migration 0100 (the `audit_events` action check); amends the outputs-only rule of `RuntimeWorkspaceLifecycle.promoteOutputs`, [ADR-0146](0146-attachments-are-file-store-references-on-the-grant-path.md) Decision 2 (the grant path) and records a reading of spec §53

## Context

The portal implementation guide's F-4 is done when an agent recalls a fact in a new session and a
member deletes it. The U5.5a spike (#1525) compared the candidates against five criteria: recall,
scope, inspect, delete and audit. Its findings, checked on the branch this record lands on:

- **Engine-native memory cannot carry a fact.** The Claude Agent SDK keeps agent memory and
  auto-memory under its config directory. The platform puts that directory at `<cwd>/.claude`, the
  runner refuses to place an assigned file there, and `cwd` is new for every session
  (`<workspaceRoot>/<workspaceId>/<sessionId>`). Mastra's memory is one thread per session, and its
  only cross-thread key is the workspace.
- **A workspace-root `CLAUDE.md` is read, but a run cannot write it.** Everything a run writes is
  promoted under `runs/<runId>/outputs/`, "never at a bare workspace path"
  (`RuntimeWorkspaceLifecycle.promoteOutputs`).
- **A `read-write` storage-connection grant survives sessions today**, but it needs an
  admin-connected bucket, and reading and deleting a fact happen outside the platform's file
  browser.

The spike recommended candidate C: files-as-memory with write-back to a granted folder, scope
`agent` first.

## Decision

1. **The permission.** `AgentPermissions` gains an optional `memory`, next to `writeFiles`, whose
   only value is `'agent'`. Absent means off, so every stored agent is unchanged. It is not one of
   the four switches (`AGENT_PERMISSION_KEYS`): an engine arm cannot withhold it by name and a
   ceiling cannot cap it by name. It is **in force only while both `readFiles` and `writeFiles` are
   on** (`agentMemoryEnabled`), so anything that narrows a file switch turns memory off with it: a
   withholding arm, the deployment ceiling, a run-level override (a public share runs with
   `writeFiles: false`). Memory never widens a run. The narrowing functions carry the value as
   stated (`policyNarrowedPermissions`, `meetPolicyCeiling`). The jsonb `agents.permissions` column
   takes it without a migration. The SDK's `defineAgent` takes `permissions.memory`, the same name.
2. **One folder per agent, keyed by id.** The folder is `memory/<agentId>/` in the workspace file
   store, area `files`. The issue wrote `memory/<agentName>/`. A name is mutable, may hold characters
   the object store refuses, and can be given to a new agent after a rename, which would inherit the
   old agent's memory. The id has none of those problems, so this record keys by id
   (`agentMemoryFolder`).
3. **Materialised on the grant path.** When a run keeps memory, the resource loader lists the
   folder's ready files and hands each to the run as a `read-write` file reference at
   `memory/<path>` under its working directory, after a `read-write` directory grant `memory`, so an
   empty folder is still a writable `memory/` (`0755` directory, `0644` files, the modes of any
   `read-write` grant). This is ADR-0146 Decision 2's path, unchanged downstream: the same
   reference, the same checksum check in the runner, the same input archive, the same removal of a
   revoked file within a session. The runner and its protected `.claude` rule do not change.
   - The memory folder owns `memory/`: any other grant or attachment that would land under it is
     dropped from the run (`withMemoryFiles`), so nothing else is handed there or written back from
     there.
   - A run's `fileScope` does not narrow the folder. A run handed part of its memory would write the
     rest back over what it was not shown.
   - The run's file-search snapshot (`runs.file_grants`, ADR-0147) leaves the folder out: its run
     path `memory/` is not the workspace path `memory/<agentId>/`, and recording it would let a
     search reach every agent's memory. Search does not read memory.
4. **Written back after a completed run, and only then.** After a run that concludes `completed`
   within its lifetime, the launcher collects `<cwd>/memory/` the way it collects `outputs/` and
   calls `promoteOutputs(…, { base: '<cwd>/memory', target: 'memory/<agentId>' })`. `target` is a
   new option; its default is unchanged (`runs/<id>/outputs/`), and the lifecycle refuses any target
   but the run agent's own memory folder. This is the one named exception to the outputs-only rule.
   - **Bounds.** At most 64 files (`AGENT_MEMORY_MAX_FILES`) and 256 KiB in total
     (`AGENT_MEMORY_MAX_BYTES`). Over either, the whole write-back is refused before anything is
     written, and the run fails with `memory_limit_exceeded`, named in its error. The archive is
     capped on the wire just above the bounds, so an oversized folder is refused without being read
     whole.
   - **Symlinks** are refused by the archive itself, on the runner and on a local-disk host alike;
     the collection fails and nothing is written.
   - **Only new or changed files** are written; a file whose bytes equal the stored row's is left as
     it is. **Nothing is deleted**: a file the agent removed from `memory/` stays in the folder until
     a member deletes it.
   - A run that fails, is cancelled or outlives its lifetime writes nothing back.
5. **Audited, naming the run.** A run that wrote at least one memory file leaves exactly one audit
   row, action `memory-updated`: actor the run's principal, actor label `run <runId>`, subject the
   agent, subject label the run id and counts only (`memoryUpdatedLabel`), never a path or a fact.
   The house slug is kebab-case, so the issue's `memory.updated` is spelled `memory-updated`.
   Migration 0100 widens the `audit_events_action_valid` check; it is expand-only.
6. **The engine is told one line.** The Claude adapter appends one system-prompt line that names
   `memory/MEMORY.md`, only when the run keeps memory (`CLAUDE_MEMORY_INSTRUCTION`). A run without
   memory compiles byte-identical options. The adapter compiles no engine-native memory: no
   `memory` on an agent definition, no `autoMemory*` setting, and the `.claude` refusal stays.
   The other engines read the folder like any granted file; they get no prompt line in this record.
7. **Inspect and delete.** A member sees the folder in the existing file browser and deletes a fact
   there (`client.files.remove('memory/<agentId>/MEMORY.md')`). The next run's materialisation no
   longer has it, because grants are loaded at launch. No memory UI is added.
8. **Authority.** The write-back is a run output with a named target. It writes as the run's owner
   principal, as `outputs/` does, only into its own agent's folder, and only when the run's composed
   permissions keep memory, which needs the composed `writeFiles`. An agent cannot write any other
   workspace path through it.

### Not a memory engine (spec §53)

Spec §53 forbids the control plane from becoming an agent framework, and lists `MemoryEngine`. This
record is not one. The platform stores, secures and observes a folder; it does not search it, rank
it, embed it, summarise it or inject a fact into a prompt. The engine reads the file with its own
file tools. The one prompt line names a path, not a fact. ADR-0147's lexical-only search does not
read the folder, and nothing here adds a vector or an embedding. Spec §53's text is unchanged; it
points here.

### Deferred: per-person memory

`memory: 'agent+user'` (one folder per agent and person, `memory/<agentId>/<userId>/`) needs
per-person file grants (#1281, open): without them a folder cannot be scoped to one person. Until
then the contract refuses the value, as it refuses any unknown one. It is added with #1281.

## Alternatives considered

The spike's table has the evidence for each.

- **A. A workspace-root `CLAUDE.md` as an assigned file.** It is read, but an agent's write lands
  in `runs/<id>/outputs/CLAUDE.md`, so only a member-written fact is recalled.
- **B. Claude agent memory or auto-memory.** It lives in the per-session, protected `.claude`
  directory: it does not survive a session, cannot be granted, inspected or deleted, and nothing
  audits it.
- **C-today. A `read-write` storage-connection grant.** It works in code, but needs external
  storage, is not inspectable or deletable in the platform, and its write-back never deletes.
- **D. Mastra memory.** One thread per session; the cross-thread key is the workspace, which fails
  the scope criterion.
- **A platform memory resource** (a memory table, a search API, retrieval into prompts). Not
  needed: candidate C meets the five criteria without one, and O-3 records that it is not built.

## Consequences

- An agent with `memory: 'agent'` recalls in a new session what it wrote in an earlier one, and a
  member can read and delete each fact in the file browser.
- A runner image older than this record's contracts refuses a request whose permissions carry
  `memory` (the run-protocol schema is strict). A request without it is unchanged.
- The total of a run's files still counts against the run file limit, memory files included.
- **`agent` scope is shared by every person who runs the agent.** The folder is keyed by the agent
  alone, and the loader lists it for the workspace with no person filter, so every run of the agent
  is handed it, whoever started the run. A fact the agent writes in person A's run (for example,
  something taken from A's prompt or from a file only A assigned) is read in person B's next
  session. The same folder is a persistence channel for injected instructions: one run that is fed a
  hostile file or message can write instructions into `memory/MEMORY.md`, and every later run of the
  agent, for every person, reads them. This is the same exposure as any workspace file a member can
  read in the file browser, and the `memory-updated` audit row names the run that wrote it, but the
  reader is the agent, not a member choosing to open a file. Turn `memory` on only for an agent
  whose users may see each other's facts, and keep a person's private material out of its runs.

### Declared gaps

- **Memory is not scoped to a person.** `agent` scope crosses people, as Consequences records.
  Shortcut: one folder per agent, shared by every person who runs it, with the disclosure and the
  injection-persistence risk stated in the SDK's `defineAgent` documentation. Upgrade: `agent+user`
  scope (`memory/<agentId>/<userId>/`) with per-person file grants (#1281); until then, an operator
  who needs isolation leaves `memory` off.
- **The real-runtime acceptance did not run.** Docker and the local runtime were not available to
  the implementing agent. Shortcut: the three-session acceptance (write, recall, then delete and no
  recall) runs at the launcher over the real lifecycle, loader and storage service with a scripted
  runtime double (`apps/web/server/runs/launcher.memory.test.ts`). Upgrade: a Node script run by a
  Docker job with the scripted fake model, when that lane covers files.
- **Within one session, a file the agent created in the previous turn and a member then deleted
  stays in that session's sandbox** until the session ends, because the runner removes only files it
  was handed earlier. A new session never has it. Upgrade: if a member asks for it, a delete also
  marks the session's next run.
- **The write-back does not re-read the agent at save time.** It trusts the composed permissions of
  the run, as `outputs/` does. Upgrade: copy the storage write-back's fresh read if memory is ever
  granted by something that can change during a run.
