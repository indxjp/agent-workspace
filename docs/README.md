# Docs

Start here to find the document for a task. Read the rows for what you are doing; skip the rest.
Before any change, read [AGENTS.md](../AGENTS.md), [ENGINEERING_GUIDELINES.md](../ENGINEERING_GUIDELINES.md)
and [architecture.md](architecture.md). [llms.txt](../llms.txt) lists the same documents in reading order.

Using Agent Workspace rather than changing it? The [developer docs site](sdk/site/index.mdx)
(published at <https://docs.agentworkspace.indx.jp>) follows one path in seven chapters, read in
order: [1 run your first agent](sdk/site/path/first-agent.mdx), [2 build](sdk/site/path/build.mdx),
[3 test](sdk/site/path/test.mdx), [4 embed](sdk/site/path/embed.mdx),
[5 ship](sdk/site/path/ship.mdx), [6 operate](sdk/site/path/operate.mdx) and, optionally,
[7 other platforms](sdk/site/path/platforms.mdx).

## Doing X → read Y

| Doing                                          | Read                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Learning what the product is                   | [spec.md](spec.md) (the combined specification), [10-product/sdk/README.md](10-product/sdk/README.md)                                                                                                                                                                                                                                     |
| Finding which component owns some code         | [20-design/architecture/ssot/ARCHITECTURE.md](20-design/architecture/ssot/ARCHITECTURE.md) (components, flows, change guide; generated from `.jevlint/architecture/`)                                                                                                                                                                     |
| Changing code inside `apps/web/server`         | [architecture.md](architecture.md) (ports and adapters, server contexts), then the owning component in [ARCHITECTURE.md](20-design/architecture/ssot/ARCHITECTURE.md)                                                                                                                                                                     |
| Changing a wire field, route or SDK method     | [10-product/sdk/07-structure-map.md](10-product/sdk/07-structure-map.md), [10-product/sdk/04-api-specification.md](10-product/sdk/04-api-specification.md), the API reports in [sdk/api/](10-product/sdk/api/)                                                                                                                            |
| Writing or changing a spec                     | [10-product/specs/TEMPLATE.md](10-product/specs/TEMPLATE.md)                                                                                                                                                                                                                                                                              |
| Finding why something was decided              | [adr/README.md](adr/README.md) (search by topic; do not read the records in bulk)                                                                                                                                                                                                                                                         |
| Refactoring                                    | [20-design/architecture/refactoring/](20-design/architecture/refactoring/claude-agent-workspace-refactoring-plan.md) (the RF-nnn plan and its decision ledger)                                                                                                                                                                            |
| Writing or placing a test                      | [testing-strategy.md](30-reference/policies/testing-strategy.md)                                                                                                                                                                                                                                                                          |
| Working on the formal model (Lean)             | [20-design/formal/README.md](20-design/formal/README.md)                                                                                                                                                                                                                                                                                  |
| Choosing an engine, platform or runtime driver | [engine-matrix.md](30-reference/matrices/engine-matrix.md), [platform-matrix.md](30-reference/matrices/platform-matrix.md), [runtime-driver-matrix.md](30-reference/matrices/runtime-driver-matrix.md), [capability-status.md](30-reference/capabilities/capability-status.md), [compatibility/](30-reference/compatibility/providers.md) |
| Adding or upgrading a dependency               | [dependency-policy.md](30-reference/policies/dependency-policy.md), [upgrade-policy.md](30-reference/policies/upgrade-policy.md)                                                                                                                                                                                                          |
| Touching run tokens or transcripts             | [security-run-session-controls.md](30-reference/policies/security-run-session-controls.md)                                                                                                                                                                                                                                                |
| Deploying                                      | [40-operate/deploy/](40-operate/deploy/single-vm.md) (single VM, Kubernetes, Azure Container Apps, Cloud Run)                                                                                                                                                                                                                             |
| Running or debugging a deployment, or CI       | [40-operate/operations/runbook.md](40-operate/operations/runbook.md), [40-operate/operations/ci.md](40-operate/operations/ci.md)                                                                                                                                                                                                          |
| Releasing                                      | [release/README.md](release/README.md); notes per version in [release/notes/](release/notes/)                                                                                                                                                                                                                                             |
| Editing the developer docs site                | [sdk/site/README.md](sdk/site/README.md)                                                                                                                                                                                                                                                                                                  |
| Working on the use-case gallery                | [10-product/sdk/gallery/README.md](10-product/sdk/gallery/README.md)                                                                                                                                                                                                                                                                      |
| Working on the Agent Store or a store entry    | [use-cases/README.md](../use-cases/README.md) (the entries), [examples/README.md](../examples/README.md) (the store app), [store guide](sdk/site/features/agent-store.mdx)                                                                                                                                                                |
| Running the user walkthrough                   | [walkthrough/README.md](walkthrough/README.md)                                                                                                                                                                                                                                                                                            |

## What to skip

- `adr/` (399 records): open the one record a task names; [adr/README.md](adr/README.md) explains how to print the index.
- `sdk/site/` (the published site): read it only to edit a page. `sdk/site/reference/` and `sdk/site/openapi.json` are generated.
- `10-product/sdk/api/*.api.md`, `20-design/formal/catalogue.md`, `20-design/formal/traceability.md`, `20-design/architecture/ssot/`: generated. Edit their sources, not these files.
- `research/fixtures/`: test fixtures, not documents.
- `20-design/architecture/as-is/` and `20-design/architecture/to-be/`: dated snapshots that the RF-nnn plan cites. [architecture.md](architecture.md) and [ARCHITECTURE.md](20-design/architecture/ssot/ARCHITECTURE.md) are current.
- `metrics/`: recorded baselines.

## Specs

A change to the product's behaviour gets its own spec in [10-product/specs/](10-product/specs/TEMPLATE.md), named by date:
`YYYY-MM-DD-[<TASK-ID>-]<slug>.md`, for example `2026-11-18-run-pause-cannot-fail.md`. Dates, not
numbers, because parallel agents would race for the next number (ADR-0003). [spec.md](spec.md) stays
the combined specification.

## Outside docs/

- `.jevlint/architecture/`: the architecture source that [ARCHITECTURE.md](20-design/architecture/ssot/ARCHITECTURE.md) is rendered from.
- `internal/`: private working material and history (plans, wave records, research). It is not part of the public export.
