# ADR-0165 — The §42 gate resolves an example app as its own install would, and holds its manifest to the engine's pin

Status: accepted
Date: 2026-11-01
Decided by: the implementing agent of U6.2-b (issue #1531, agent portal programme, tracker #1476), on the Owner's delegation for the programme
Scope: `tests/no-sdk-import.test.ts` (section 3b and the two manifest tests); `examples/**`

## Context

`examples/` holds the apps the portal benchmark scores (`examples/README.md`). Each is a
customer's project: written by `npm create @indx-workspace` and `aw generate`, importing only the
published `@indx-workspace/*` packages, and on purpose **not** a pnpm workspace member, because a
member would resolve those packages to this repository's sources and so defeat the No fork cell.
Nothing installs an example in a checkout; the apps lane installs a copy of it against the packed
packages.

The §42 gate (`tests/no-sdk-import.test.ts`) scans every tracked module and refuses any reference
it cannot resolve (ADR-0031). On `examples/minimal` it was red twice:

- 26 references refused: every bare specifier of the example (`@indx-workspace/app/server`,
  `react`, `next/headers`, …) names a package the example declares but that is installed nowhere
  the gate's resolver looks.
- The manifest test failed: `examples/minimal/package.json` declares
  `@anthropic-ai/claude-agent-sdk`, which only the engine package may. The template writes it
  because `aw dev` loads the engine the project runs from the project's own install
  (`packages/sdk/src/project/dependencies.ts`), at the engine package's exact pin.

Neither is a defect of the example, and both repairs the gate's header rules out (a directory
exclusion, or installing the example into the workspace) would stop it from seeing the example.

## Decision

1. **An example app resolves as its own install would.** A file is an example app's when it is
   under `examples/<id>/` and that directory holds a tracked `package.json` and `benchmark.ts`
   (derived from the tracked tree, ADR-0027). A bare specifier from such a file whose package the
   example's `package.json` declares, and that its own project cannot resolve, is resolved from
   inside the workspace package of each `@indx-workspace/*` package the example declares, in name
   order: the installation that, once the example is installed, holds that package and its
   dependencies. The answer is a real file, held to `sdkOwns` like every other, so an example
   that imports an SDK still fails the gate. A package the example does not declare, or one none
   of those installations resolves, is still the ADR-0031 refusal.
2. **An example's manifest has its own, narrower rule**, beside the runtime bundle's: it is left
   out of "declared by exactly one package", and a test of its own requires that there is an
   example to excuse, that an SDK appears only in `dependencies` and only at the owning engine
   package's exact pin, and that no file of an example is among the files reaching an SDK.

## Consequences

- The gate reads every file of every example and resolves each reference to a file; nothing is
  excluded. Planting `import { query } from '@anthropic-ai/claude-agent-sdk'` in
  `examples/minimal/resources/note.ts` turns both "reached by exactly the boundary file" and the
  example test red, naming the file.
- A future example that declares a package no `@indx-workspace/*` package installs (a library of
  its own) is refused until this rule is widened by a record, which is the intended direction.
- The rule rests on the published packages being the workspace packages of the same name, which
  `scripts/release/pack-packages.mjs` packs; it says nothing about versions, only identity.
