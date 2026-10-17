# Platforms journey (issue #979)

A fresh developer goes from `npm create` to `aw platforms export` for every agent platform, and each
export's verdict list is compared with a committed golden, so a dropped or re-mapped field never
changes silently. It uses no model key and no vendor CLI, and sends nothing to any platform.

1. `npm create @indx-workspace@latest demo -- --yes --theme support --platform claude-managed-agents`
   against a throwaway Verdaccio that serves this checkout's packed packages. The project has
   `agents/assistant.ts`, a `platforms:` block, and no `.agent.md`.
2. `aw platforms list --json`: the ids must equal the file names in `golden/` (a platform without a
   golden, or a golden without a platform, fails).
3. The project is made exportable: the code tool of `../tool-sandbox.e2e.mjs`, the model
   `{ connection: 'default', id: 'claude-sonnet-4-6' }` (Managed Agents refuses `default`), and every
   platform enabled with the options it needs (below). No public tool endpoint is configured, so
   every hosted platform except `gemini-enterprise` (which maps it) must report the code tool as
   dropped (`code_tool_needs_public_mcp`).
4. `aw platforms export --platform <id> --json` for each id: exit 0, `PLATFORM_REPORT.md` and at
   least one other file written, and the verdicts equal `golden/<id>.json`. Every difference of every
   platform is collected and reported once, naming the platform and the path.
5. Refusals: `--strict` with a dropped field exits 5; a non-Claude model (`openai/gpt-5`) for
   `claude-managed-agents` exits 1 with `platform_model_unsupported`; an unknown platform exits 2.
6. `aw platforms doctor --json` exits 0 and reports a `compile` row for every platform (a missing
   vendor CLI is a warning).
7. Round trip: the Managed Agents export is renamed to `assistant-imported`, imported with
   `aw platforms import --from claude-managed-agents --yes` (the export carries the project's own
   skill, rewritten with the same bytes), which writes
   `agents/assistant-imported.agent.md`; exporting that agent again exits 0 with the same
   instructions.

Run: `pnpm build && node tests/e2e/platforms-journey/journey.e2e.mjs`. It needs Docker (Verdaccio
only) and `npm`. It shares Verdaccio's container name with the build-to-deploy journey, so run the
two one at a time on one Docker daemon. CI: the `platforms-journey` job of
`.github/workflows/journey-live.yml` (no secret; on a pull request only when the diff touches the
platforms or this journey; not in `ci-success`).

| Variable                | Default                   | Meaning                                                  |
| ----------------------- | ------------------------- | -------------------------------------------------------- |
| `PJ_WORK_DIR`           | a new temporary directory | where the project, `out/` and `evidence/` go             |
| `PJ_NPM_PORT`           | `4874`                    | Verdaccio's port (the build-to-deploy journey uses 4873) |
| `PJ_PREPARE_TIMEOUT_MS` | 15 minutes                | the cap on packing and publishing the packages           |
| `PJ_WRITE_GOLDEN`       | unset                     | `1` rewrites `golden/*.json` instead of comparing        |

`evidence/` holds `commands.log` (every `aw` call with its exit code, stdout and stderr), `verdicts/`
(the normalised verdicts of this run, one file per platform) and `out/` (every export).

## Options the journey writes

A fresh project exports without edits only to `m365-declarative-agent`; the others refuse until their
required options are set. The journey writes these placeholders (`PLATFORM_OPTIONS` in
`journey.e2e.mjs`; none is a credential or a real tenant, project or account):

| Platform            | `platforms.<id>.options`                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `copilot-studio`    | `publisherPrefix: demo`                                                                                             |
| `microsoft-foundry` | `modelDeployment: demo-deployment`                                                                                  |
| `gemini-enterprise` | `projectId: demo-project`, `location: global`, `engineId: demo-engine`, `publicBaseUrl: https://agents.example.com` |
| `aws-agentcore`     | `region: us-east-1`, `accountId: "123456789012"`                                                                    |

## Updating a golden

A golden is a pretty JSON array of `{ path, verdict, code? }` sorted by `path`; the prose `note` is
not compared. When a translator's rule changes on purpose, rewrite the goldens and review the diff:

```sh
PJ_WRITE_GOLDEN=1 node tests/e2e/platforms-journey/journey.e2e.mjs
```

Without Docker, copy `evidence/verdicts/<id>.json` from the `platforms-journey-evidence` artifact of
a failed CI run. A golden that disagrees with a translator's documented rule is a bug in that
translator, not something to accept here.

The pure helpers (`verdicts.mjs`) are unit-tested by `verdicts.test.ts` in `pnpm test`.

## Live lane: Claude Managed Agents

`managed-agents-live.e2e.mjs` publishes the same agent to Claude Managed Agents with the real `ant`
CLI, reads it back and removes it again. It creates real resources in the account of the key, so it
runs only from `workflow_dispatch` (`platforms-live-managed-agents` in `journey-live.yml`; never on a
pull request or a schedule, and not in `ci-success`).

```sh
pnpm build
ANTHROPIC_API_KEY=… PJ_LIVE_RUN_ID=<digits> node tests/e2e/platforms-journey/managed-agents-live.e2e.mjs
```

It needs Docker (Verdaccio), `npm`, and `ant` 1.30.0 or newer on `PATH`. Without `ANTHROPIC_API_KEY`
it exits 1 ("skipped is not a pass"). `PJ_LIVE_RUN_ID` (digits; CI passes the workflow run id) names
the agent `awpt-<run id>`; `PJ_WORK_DIR`, `PJ_NPM_PORT` and `PJ_PREPARE_TIMEOUT_MS` are as above.

1. The journey's project without the code tool (so nothing is dropped), exported, the agent renamed
   to `awpt-<run id>` and imported as `agents/awpt-<run id>.agent.md`.
2. `aw platforms publish … --agent awpt-<run id>` without `--yes`: exit 3, a plan that names the
   agent, and no such agent in the Managed Agents list.
3. The same with `--yes`: exit 0, and the list (`GET /v1/agents`) shows the agent with the id that
   `claude-lock.json` recorded.
4. Always, also on SIGINT/SIGTERM: every agent, skill and environment in `claude-lock.json` and
   every active agent named exactly `awpt-<run id>` is removed, in reverse dependency order: agents
   (`ant beta:agents archive`), then skills (`ant beta:skills delete`), then environments (`ant
   beta:environments delete`). A kind the lane cannot remove fails the run, naming the kind and id.
   Agents are listed again, and so are environments (`GET /v1/environments`); a leftover agent, a
   lock-recorded environment still listed, or an `ant` failure fails the run. The export carries the
   project's `skills/refund-policy`, which `ant apply` uploads as a custom skill, hence the skill
   delete; `ant apply` also creates `environments/default.yaml`, hence the environment delete. The
   environment left by run 38268523261 is removed by hand by the Owner; the lane does not sweep it.

The key is read from the environment only, added to `SECRETS` before any command, given to the
publish and `ant` children through their environment (never an argument), and every line the script
prints or writes to `evidence/` is scrubbed.

**VERIFY.** The list endpoint and its response shape come from
<https://platform.claude.com/docs/en/api/beta/agents/list> (header `anthropic-beta:
managed-agents-2026-04-01`, `limit` up to 100, an opaque `page` cursor) and are committed as
`fixtures/agents-list.json`, tested in `verdicts.test.ts`. The documentation (read 2026-10-12) lists
`next_page` as an optional string or null, so absent or null is the last page and any other type is
refused; the first dispatch (run 38250183452) failed on the earlier parser, which required the field.
A refused response is logged by its top-level key names only, and the lane prints `FAILED at step
"…"` before it cleans up. The
archive command is <https://platform.claude.com/docs/en/api/cli/beta/agents/archive>, the skill
delete <https://platform.claude.com/docs/en/api/cli/beta/skills/delete>. These are confirmed against
the documentation, not yet against a dispatched run: the first dispatch also settles whether
`ant beta:*` reads `ANTHROPIC_API_KEY` from the environment, and whether a skill can be deleted
without deleting its versions first. If a cleanup call fails, the job fails naming the id to remove
by hand in the Claude Console.

The environment commands were read on 2026-10-13 and are not yet confirmed by a dispatch: delete is
<https://platform.claude.com/docs/en/api/cli/beta/environments/delete> (`ant beta:environments
delete --environment-id <id>`), the re-list is
<https://platform.claude.com/docs/en/api/beta/environments/list> (`GET /v1/environments`, active
only; same page shape, committed as `fixtures/environments-list.json`).

**The pinned `ant`.** The workflow installs the release tarball
`https://github.com/anthropics/anthropic-cli/releases/download/v${ANT_VERSION}/ant_${ANT_VERSION}_linux_amd64.tar.gz`
in a `run` step (no action; `scripts/check-workflows.mjs` allow-lists every action) and checks it
against `ANT_SHA256`. To bump: take the version and the `linux_amd64` line of that release's
`ant_<version>_checksums.txt` and change `ANT_VERSION` and `ANT_SHA256` together.

## Not here yet

Live publish to any other platform, and running a session against the published agent.
