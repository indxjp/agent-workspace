# Enterprise use-case gallery

Ten agents Japanese enterprises ask for, each built end to end with the Agent Workspace SDK, and
each kept as a **benchmark** of what the SDK does today. The tutorials are on the docs site under
[Enterprise use-case gallery](../../docs/sdk/site/tutorials/index.mdx); this directory is their
code, and the tests here are what make every claim in them true.

```sh
pnpm vitest run --project tests tests/gallery                  # everything, offline, no API key
pnpm vitest run --project tests tests/gallery/manual-search    # one use case
GALLERY_WRITE=1 pnpm vitest run --project tests tests/gallery/benchmark.test.ts   # regenerate tables
```

## Layout

| Path | What it is |
| --- | --- |
| `<use case>/` | One project as a developer would write it: `agent-workspace.yaml`, `agents/`, `surfaces/`, `skills/`, `evals/`, its own MCP servers (`mcp/`) or tools (`tools/`, `apis/`), Japanese fixture data (`data/`), the backend code around the agent (`backend/`), its `benchmark.ts` and its tests. |
| `shared/` | Code several use cases share: the MCP server kit, the Japanese bigram index, `runAndRead`, the citation parser, and the `office-reader` skill (xlsx and docx with Node alone). |
| `harness/` | Test machinery only: the project loader, the MCP client, the scripted workspace, the gap probes, the benchmark model and the registry. |
| `benchmark.test.ts` | Every verdict has evidence that exists; every tutorial's status table matches its benchmark. |
| `probes.test.ts` | Every gap the gallery reports is still a gap. |

## What a test here proves, and what it does not

- **Contract tier.** A project is loaded the way `aw check` loads it: definition files through
  `toAgentVersionBody`, which applies the server's `AgentVersionBodySchema`; the project file and
  eval files through the SDK's own readers. A project that loads here is one the contract accepts.
  The server's checks beyond the contract (an engine that cannot run a tool, a connector that does
  not exist yet) need a workspace.
- **Flow tier.** The backend code runs unmodified against `harness/scripted-workspace.ts`: the SDK
  client and the use case's MCP servers are real, every event frame is built to the contract, and
  only the model's decisions are scripted. It proves the plumbing and the guards around the agent,
  not that a model makes these decisions.
- **Probe tier.** `harness/probes.ts` asks the published contracts whether a missing capability
  exists. Each probe fails the day it does, naming the benchmark cells to update.
- **Live tier.** `aw dev`, `aw push` and `aw eval` on a real workspace and model. It is run by you,
  never claimed by CI.

## Adding a use case

Create `tests/gallery/<id>/` with a `benchmark.ts` (`order` is its place in the gallery) and a
`<id>.test.ts` whose titles the benchmark's `contract` cells cite, register the benchmark in
`harness/registry.ts` (imports are static: the import-boundary gate refuses a computed `import()`),
add `docs/sdk/site/tutorials/<id>.mdx` with the `benchmark:start`/`benchmark:end` markers, list the
page in `docs/sdk/site/docs.json`, and run `GALLERY_WRITE=1` once. `benchmark.test.ts` fails if a
directory is not registered.
