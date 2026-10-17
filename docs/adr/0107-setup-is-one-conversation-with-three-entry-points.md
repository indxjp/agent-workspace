# ADR-0107 — Setup is one conversation with three entry points

Status: accepted in part (slice 1: the question set as a contract, and `aw init` and `npm create` writing the same files from it; slice 2: setup themes, `aw init` asking on a TTY, and the hand-off line); 2026-10-06: `npm create` may offer to install and start `aw dev` on a terminal, recorded as an amendment (UX-D, #760); the rest remains proposed — draft from the developer-journey hearing (decisions D4, D12)
Date: 2026-10-01
Decided by: the product owner, in the developer-journey hearing; slice 1 accepted 2026-10-02 by the planning writer of the developer-journey delivery on the Owner's delegation (see "Slice 1 acceptance"); slice 2 accepted 2026-10-03 by the implementing agent of S2-00b on the Owner's delegation (see "Slice 2 acceptance"); the rest to be confirmed when it is accepted
Scope: `packages/create`, `packages/cli` (`create`), `packages/aw` (`init`), `apps/web` (`/setup`), a Claude Code plugin

## Slice 1 acceptance

Accepted on 2026-10-02 for slice 1 of the developer-journey delivery
(the delivery plan), by the planning writer on the
Owner's delegation. Only the decisions below are accepted. Everything else in this record remains
proposed.

Accepted now:

- **The question set is a contract.** `@indx-workspace/contracts/setup` exports
  `SETUP_QUESTIONS` (each with an id, an audience, a prompt, its choices or grammar, a recommended
  answer and the files it writes), `SetupAnswersSchema` and `withRecommendedAnswers()`. Slice 1
  has five questions: `admin.sandbox`, `content.agentName`, `content.engine`,
  `embedder.surfaceTitle` and `embedder.brandColour`.
- **Two entry points write the same files through one renderer** in
  `@indx-workspace/sdk/project`: `aw init [--yes]`, in the current directory and with no control
  plane, and `npm create @indx-workspace <dir> [--yes]`. Both write `agent-workspace.yaml` (v2),
  `agents/<name>.ts` and `surfaces/main.ts`. `create` also writes the project shell
  (`package.json` with `"dev": "aw dev"`, `pnpm-workspace.yaml`, `.gitignore`). A test holds the
  two outputs byte-equal.
- **`--yes` fills every answer with the recommended one, and the result runs.** Without a TTY and
  without `--yes`, both refuse with that hint. `create --cloud …` keeps the v1 path.
- **No answer is a secret, and no secret reaches a file.** The model key is not a setup question
  in slice 1: `aw dev` reads `ANTHROPIC_API_KEY`, and an optional `ANTHROPIC_BASE_URL`, from its
  own environment and creates the workspace's `default` model connection through the API when
  none exists.
- An engine and capability combination that cannot run is reported by `aw check` as
  `422 engine_capability_unsupported` (the server's dry run), not by the questions themselves.

Still proposed: the browser `/setup` conversation and its one-time link, `npm create` starting
`aw dev` and choosing an entry point, the Claude Code plugin, themes, retiring the five-step
wizard and `create`'s four prompts (they stay on the v1 path), and ending setup with `aw login`
(in slice 1, `aw dev` signs `aw` in itself, ADR-0109).

## Slice 2 acceptance

Accepted on 2026-10-03 for slice 2 of the developer-journey delivery
(the delivery plan, §8), by the implementing agent of
S2-00b (issue #521) on the Owner's delegation. Only the decisions below are accepted. Everything
else in this record remains proposed. Tools defined in code are decided in
[ADR-0113](0113-tools-defined-in-code-are-catalog-connectors-that-run-in-the-gateway.md), not here.

Accepted now, as SD9 of the plan:

- **Setup starts with a theme.** The themes are `support`, `copilot`, `knowledge`, `automation`,
  `review` and `blank`; `blank` renders the slice-1 files. The docs' use case 2 maps to teams
  (slice 7) and use case 6 to the admin questions, so neither is a theme.
- **`aw init` asks on a TTY through the loop `create` uses** (contract C20). Today it renders the
  recommended answers and asks nothing (`packages/aw/src/commands/init.ts:38-47`). Both entry
  points write byte-identical files per theme. `SETUP_QUESTIONS` keeps one prompt shape, and the
  journey's answer budget is `SETUP_QUESTIONS.length + 2`, never a literal.
- **U-7 is a closing hand-off line**: both entry points end by saying what to run next.
- **Declared gap: `aw login`'s user token cannot push.** The catalogue routes refuse it
  (`apps/web/server/cli-auth/token-routes.ts:12-19`, ADR-0083 §4), so the hand-off line says so
  until an ADR-0083 amendment admits user tokens there (not planned).

Still proposed: the browser `/setup` conversation and its one-time link, `npm create` starting
`aw dev` and choosing an entry point, the Claude Code plugin, retiring the five-step wizard and
`create`'s four prompts, and ending setup with `aw login`.

## Context

Today a first run asks questions in two places:

- `create-agent-workspace` asks four questions in the terminal: Database, Storage, Runtime and
  Authentication. The cloud is chosen with the `--cloud` flag.
- `/setup` is a five-step wizard: Provider, Credentials, Runtime, Administrator and First agent.

Runtime is asked in both places. The administrator's one-time password is printed once in the
terminal and typed into step 4. `/signin` does not link to `/setup`. The first API key must be
created in the UI before `aw` can do anything. Tools, skills and files are added afterwards, one by
one. None of the answers become files.

## Decision

- `npm create @indx-workspace` checks prerequisites, creates the directory, starts `aw dev`
  (ADR-0103), and asks only where to continue: the browser, the terminal or Claude Code.
- The three entry points ask the **same questions**, defined once, and write the **same files**:
  - the browser at `/setup`, opened with a one-time link instead of a password;
  - `aw init` in the terminal;
  - `/agent-workspace:init` in Claude Code.
- The conversation starts from a **theme**, one of the documented use cases. The theme sets the
  recommended answers and the sample content (D12).
- Questions are grouped by who answers them:
  - admin: cloud, sandbox, sign-in, models — written to `agent-workspace.yaml`;
  - content: engine, team shape, tools, skills, files, permissions — the first version
    (ADR-0101), written to `agents/` and `tools/`;
  - embedder: audience and look — written to `surfaces/`.
- Every answer shows the file lines it changed. Every question has a recommended answer, and
  "fill the rest with recommendations" always produces a project that runs.
- A combination an engine cannot honour is refused on the spot with
  `422 engine_capability_unsupported`, and two fixes are offered. It is never silently dropped.
- Setup ends by offering `aw login` (device code, which exists today) instead of a UI-created API key.

## Alternatives rejected

- **Terminal only** (create-next-app style). Rejected as the only entry: the content questions
  read better with the file diff beside them.
- **Keep the wizard and the terminal questions separate** (today).

## Consequences

- The question set becomes a contract (a schema in `packages/contracts`) so the three entry points
  cannot drift.
- `create`'s four terminal prompts and the five-step wizard are retired. Piped, non-interactive
  generation (`--yes`, CI) keeps working with the recommended answers.

## Amendment — `npm create` may install and start `aw dev` (UX-D, issue #760, 2026-10-06)

The Owner asked for a first install with no thinking, and `npm create` stopping at a list of commands to copy is the last place the person must think. This accepts one more slice of this ADR: on a terminal, `npm create` may offer to install the dependencies and to start `aw dev` in the new project.

- After writing the files it asks `Install dependencies now?` and, once installed, `Start it now?`, both Yes by default. It runs the package manager that ran it (npm, pnpm, yarn or bun, from `npm_config_user_agent`) in the project directory with the terminal inherited, so the person lands on the `aw dev` ready screen, which asks for the model key and offers to open the chat.
- `--install` / `--no-install` and `--start` / `--no-start` answer the questions. `--yes` means install and do not start: a coding agent or CI must not block on a foreground server. With no terminal nothing is installed or started unless a flag says so, so non-interactive use keeps the same defaults as before.
- It also asks `Project name` (default `my-agent`) when no directory is given, and prints the next steps only for what it did not do, in order, with the model-key line for the person's shell. The `aw login` hand-off line (SD9) is no longer printed by `create`; it stays in `aw login --help` and the docs, and `aw init` is unchanged.
- This does not change the other decisions: the three entry points still ask the same questions and write the same files, and no key is ever written to a file.

## Amendment — No person, no prompt (VC-1, #879)

An automated run (a coding agent, CI, a script with a pipe) must never wait for an answer nobody will type. This accepts one more rule for the three entry points: a prompt needs a person, and the absence of a person is decided in one place.

- "No person" means standard input or standard output is not a terminal, or `CI` is set to anything but empty, `0` or `false`. `isInteractive()` in `packages/sdk/src/project/ask.ts` decides it; `aw` re-exports it and `create` calls it, so the two cannot disagree.
- With no person a command completes from flags, an answers file (`--answers <file>`, YAML or JSON keyed by question id, validated by `SetupAnswersSchema`, flags win), the environment or `--yes`; or it exits with a `fix:` line naming the missing setting. `aw init` and `create` with a provider that needs an endpoint and no `--model-base-url` exit 2 with `fix: add --model-base-url <url>` and write nothing.
- Standard input is read only as an explicit input (`--api-key-stdin`, `--value-stdin`, `--file -`). On a terminal those flags exit 2, and a pipe that stays silent for ten seconds exits 2, instead of waiting. `create --cloud local` no longer reads its four answers from stdin; they are `--database`, `--storage`, `--runtime`, `--auth`, or the defaults with `--yes`.
- `aw login` needs a person at a browser, so with none it exits 1 at once with `fix: set AGENT_WORKSPACE_API_KEY`.
- Usage refusals exit 2 (`UsageError` in `aw`, `CreateUsageError` in `create`); the older `create` flag-combination refusals keep exit 1.
- Not changed: the questions, their order and the files written. `CI=true` on a real terminal is now non-interactive, so a person who wants the interview there sets `CI=false`.
