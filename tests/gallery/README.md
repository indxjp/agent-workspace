# Enterprise use-case gallery

Ten agents Japanese enterprises ask for, each built end to end with the Agent Workspace SDK, and
each kept as a **benchmark** of what the SDK does today. The tutorials are on the docs site under
[Enterprise use-case gallery](../../docs/sdk/site/tutorials/index.mdx); this directory is their
code, and the tests here are what make every claim in them true.

```sh
pnpm vitest run --project tests-gallery tests/gallery                  # everything, offline, no API key
pnpm vitest run --project tests-gallery tests/gallery/manual-search    # one use case
GALLERY_WRITE=1 pnpm vitest run --project tests-gallery tests/gallery/benchmark.test.ts   # regenerate tables
```

## Layout

| Path | What it is |
| --- | --- |
| `<use case>/` | One project as a developer would write it: `agent-workspace.yaml`, `agents/`, `surfaces/`, `skills/`, `evals/`, its own MCP servers (`mcp/`) or tools (`tools/`, `apis/`), Japanese fixture data (`data/`), the backend code around the agent (`backend/`), its `benchmark.ts` and its tests. |
| `shared/` | Code several use cases share: the MCP server kit, the Japanese bigram index, `runAndRead`, the citation parser. The `office-reader` skill (PDF, xlsx, docx and DXF with Node alone) is a built-in: it lives in `packages/skills-office`. |
| `harness/` | Test machinery only: the project loader, the MCP client, the scripted workspace, the doubles for the platform's `search_files` tool and its `openapiTool()` gateway, the gap probes, the benchmark model and the registry. |
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

## Coverage

`pnpm test:coverage:gallery` runs this project under `vitest.gallery.coverage.config.ts`, which
measures each project's `agents/`, `backend/`, `mcp/`, `tools/`, `apis/`, `surfaces/` and `lib/`
code, its skill scripts, and `shared/`. Its floors sit one point under the measured totals, are
never lowered (`scripts/check-coverage-ratchet.mjs` in the coverage job, and
`use-cases/kit/coverage-floors.test.ts` on every run against `origin/main`), and are raised until
every file is at 100%, where the use cases already are. Most of what is not covered is skill
scripts and MCP servers the tests start as child processes, which v8 does not see.

## Handwritten lines

Each project counted by the counter the apps and the use cases share (`harness/line-counts.ts`),
against a ceiling of 150 lines, the largest use-case budget. The count leaves out Markdown, the eval
YAML, `data/` and `sample-data/`, tests and test support, `benchmark.ts`, and the fake external
systems (`<system>/fake-<system>.mjs`) that stand in for the customer's own; it adds every file in
`shared/` a counted file imports. Report-only for now: `benchmark.test.ts` keeps the table current
and fails nothing for a count over the ceiling.

<!-- line-counts:start -->

| Use case | Handwritten lines | Over 150 | Largest files |
| --- | --- | --- | --- |
| manual-search | 283 | +133 | `../shared/run-answer.ts` 141, `backend/ask.ts` 95, `agent-workspace.yaml` 18 |
| cad-drafting | 967 | +817 | `skills/dxf-draft/scripts/dxf.mjs` 410, `backend/draft.ts` 295, `../shared/run-answer.ts` 141 |
| quotation | 1062 | +912 | `backend/quote.ts` 403, `apis/erp.openapi.json` 218, `skills/cost-model/scripts/estimate.mjs` 178 |
| ringi-review | 901 | +751 | `backend/review-run.ts` 229, `../shared/mcp-server.mjs` 166, `../shared/run-answer.ts` 141 |
| customer-inquiry | 518 | +368 | `../shared/run-answer.ts` 141, `apis/crm.openapi.json` 123, `backend/chat.ts` 103 |
| excel-consolidation | 1227 | +1077 | `backend/consolidate.ts` 444, `skills/excel-consolidate/scripts/consolidate.mjs` 315, `skills/excel-consolidate/scripts/xlsx.mjs` 171 |
| contract-review | 980 | +830 | `skills/contract-playbook/scripts/clauses.mjs` 458, `backend/review.ts` 266, `../shared/run-answer.ts` 141 |
| meeting-minutes | 999 | +849 | `backend/minutes.ts` 349, `../shared/mcp-server.mjs` 166, `../shared/run-answer.ts` 141 |
| maintenance-troubleshooting | 814 | +664 | `backend/diagnose.ts` 299, `backend/inspect-turn.ts` 148, `../shared/run-answer.ts` 141 |
| quality-defect | 1087 | +937 | `backend/analyse.ts` 342, `apis/qms.openapi.json` 309, `skills/eight-d/scripts/eightd.mjs` 178 |

<!-- line-counts:end -->

## Adding a use case

Create `tests/gallery/<id>/` with a `benchmark.ts` (`order` is its place in the gallery) and a
`<id>.test.ts` whose titles the benchmark's `contract` cells cite, register the benchmark in
`harness/registry.ts` (imports are static: the import-boundary gate refuses a computed `import()`),
add `docs/sdk/site/tutorials/<id>.mdx` with the `benchmark:start`/`benchmark:end` markers, list the
page in `docs/sdk/site/docs.json`, and run `GALLERY_WRITE=1` once. `benchmark.test.ts` fails if a
directory is not registered.
