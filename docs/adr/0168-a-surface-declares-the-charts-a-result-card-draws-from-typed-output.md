# ADR-0168 — A surface declares the charts a result card draws from typed output

Status: accepted
Date: 2026-11-21
Decided by: the implementing agent of unit G2 of the 100-use-case plan (§9; tracker #2383), on the Owner's delegation for the programme
Scope: `packages/contracts/src/surface-result-charts.ts` (new), `packages/contracts/src/surfaces.ts`, `packages/react/src/result-chart.tsx` (new, exported as `<ResultChart/>`), `apps/web/components/run/run-result-card.tsx` (new), `apps/web/components/run/run-detail-panel.tsx`
Related: ADR-0143 (a run can be asked for structured output); ADR-0154 (a trigger asks its runs for it); ADR-0108 (a surface's look, layout and parts are declared, rung ②); ADR-0101 (a version's body carries its surfaces)

## Context

The use-case plan's analysis entries (archetype AN) and the reports that show a trend (kpi,
supplier, okr, survey, pulse) end in a table of numbers that reads better as a small chart. The
plan's rule is that a use case writes no code for something the platform does (§3.2). Without a
platform chart, each of those entries would draw its own, which the rule forbids, or show only
prose.

### What exists

- **Typed output.** A run asked for an `outputSchema` (ADR-0143) — by `runs.start`, a trigger
  (ADR-0154) or an eval case — answers with `RunResource.output.structured`, a JSON object of that
  schema. The run detail panel (`apps/web/components/run/run-detail-panel.tsx`) reads the run but
  shows nothing of `structured`.
- **Declared surfaces.** `defineSurface()` is exactly `SurfaceDefinitionSchema` (C3): a strict,
  transform-free object a version's body carries next to its agent definition (ADR-0101).
  `toolResults` already lets a surface render a tool's result as a built-in `card` or `table`
  (ADR-0108 SD10). Nothing renders the run's own answer.
- **No chart dependency.** The web app has no chart library, and its colours are tokens
  (`--color-accent`, `--color-muted`, `--color-border`) that change with light and dark mode.

## Options

### Option A — A surface declares `resultCharts`; the run detail panel draws them (recommended)

The surface, which already declares how a run's tools render, also declares which field of the
typed output is charted and how. The control plane draws it. A use case writes the declaration and
no code.

### Option B — The output schema carries the chart

Put the chart in the JSON Schema itself, as an `x-chart` keyword. ADR-0143 limits that schema's
dialect, depth and size and hands it to an engine; a presentation key there would reach the
model, change what an engine is asked to honour, and need every caller of `runs.start` to repeat
it. Rejected.

### Option C — A `chart` component in `toolResults`

Chart a tool's result instead of the run's answer. An analysis entry computes in a skill script
behind a generic tool (a shell), whose name says nothing about the shape, and its numbers are
final only in the typed answer. Rejected for this unit; nothing here prevents it later.

### Option D — A chart library

A library brings a dependency and its own colours for two chart forms that inline SVG draws in a
few dozen lines. Rejected.

## Decision

Option A, with these decisions.

### D1 — Where it is declared

`SurfaceDefinitionSchema` gains the optional key `resultCharts`. A run's charts are those of every
surface in the body of the agent version the run's session pins (`run.agentVersion`), in surface
order; a chart two surfaces both declare is drawn once. Every surface in a body names that body's
agent (ADR-0101), so no surface lends a chart to another agent's run.

### D2 — The spec

`resultCharts` holds 1–4 charts (`RESULT_CHARTS_MAX`). Each is strict and has:

| Key     | Meaning                                                                        |
| ------- | ------------------------------------------------------------------------------ |
| `kind`  | `bar` or `line` (`RESULT_CHART_KINDS`)                                         |
| `field` | the top-level property of the typed output that holds the rows                 |
| `label` | the key of each row's category                                                 |
| `value` | the key of each row's number                                                   |
| `title` | `{ ja, en }`, each one line of 1–80 visible characters                         |
| `axes`  | `{ label: { ja, en }, value: { ja, en } }`, the category and value axes' names |

Keys are property names (`^[A-Za-z_][A-Za-z0-9_]{0,63}$`). Both languages are required, as every
string a use case shows is (plan §3.4). There is no colour, size or nested path: the chart takes
the app's tokens, and a nested field is a reason to change the output schema, not the spec. A
surface cannot check its spec against an output schema, because the schema is a run's request,
not part of the version; D3 makes a mismatch visible instead.

### D3 — How the output is read

`resultChartData(chart, structured)` in the contracts is pure and is the only reader: it returns
the points, or a `mismatch` with a reason — `no_field` (the output is not an object or the field is
not an own array), `empty`, `too_many_rows` (over 60, `RESULT_CHART_POINTS_MAX`; rows are never
cut, since a cut chart misstates the data) or `bad_row` (a row whose label is not non-empty text or
a finite number, or whose value is not a number within ±10¹⁵, `RESULT_CHART_VALUE_MAX`, beyond
which the span of two extreme values can overflow and the scale become `NaN`). The card shows a mismatch as a sentence in
the reader's language, never as an empty or partial chart.

### D4 — How it is drawn, and read without sight

`<ResultChart/>` in `@indx-workspace/react` draws each chart, so the control plane and any page
built on the published packages (the Agent Store) draw the same one; the react package may depend
on the contracts, and the store cannot import `apps/web`. It is inline SVG whose colours are the
page's `--accent`, `--muted`, `--border` and `--surface` custom properties (the console and the
surface chat both set them), falling back to the text colour, so it needs no stylesheet: one
series, so no legend;
bars rounded at the data end from a value axis that always spans 0; a 2-pixel line with a marker
per row; the value axis's two ends and the first and last category as labels, a category label
cut to 14 characters with an ellipsis and its whole text in a tooltip; each mark's value in a
native tooltip. The SVG is hidden from assistive technology, and the same rows are a data table
(visually hidden) whose caption is the title and whose column headers are the declared axis
labels. Every value is a text node.

### D5 — Where it is shown, and when not

The run detail panel gains a "Result" card (結果) under the overview. It reads the agent's
versions only for a run that has typed output and a pinned version. It renders nothing when no
surface declares a chart, or when the versions route refuses (`403`) or conceals (`404`) them; any
other failed read says so (the sentence is the alert; the retry button sits outside it).

**Open gap: the Agent Store and the hosted chat do not show the chart yet.** G2 exists for the
store's analysis entries, and today no store visitor sees a chart: the store's demo chat starts its
runs without an `outputSchema`, so they carry no typed output, and its replay of a recorded answer
flattens JSON to bullets. This ADR does not settle that the store has "nothing to chart"; it
leaves the store path to a follow-up unit, **G2b** in the use-case plan (§9): the catalog entry's
demo declares an output schema, the demo chat passes it to `runs.start` and keeps
`run.output.structured`, the entry's surface charts are read at build time, `<ResultChart/>`
renders under the answer, and a recorded turn records `structured` so recordings and screenshots
show it. G2b reuses `<ResultChart/>` and `resultChartData` unchanged.

## Consequences

- An analysis or report entry shows its numbers as a chart by declaring about ten lines in
  `surfaces/main.ts`, and counts no chart code against its budget.
- `SurfaceDefinitionSchema` accepts one more key. An older control plane refuses a version that
  uses it, which the lock-step release of contracts, SDK and `aw` makes the expected outcome.
- The run detail panel makes one more read (`GET /api/agents/:id/versions`) for a typed run. That
  route lists every version with its body, so the read grows with the agent's history; a route
  that answers one version would make it constant, and is left until a measurement asks for it.
- Until G2b lands, only a person who opens the run detail panel sees the chart (D5).
- Two chart forms only. Another form, a second series, or a chart in the hosted chat is a new
  decision, not a new key added here.

## Proof

- `packages/contracts/src/surface-result-charts.test.ts`: every key and bound of D2, each mismatch
  of D3 including the value bound, and own-property reading.
- `packages/sdk/src/define/surface.test.ts`: `defineSurface()` accepts a chart unchanged, types it
  as `readonly ResultChart[] | undefined`, and refuses an empty list and an unknown kind by path.
- `packages/react/src/result-chart.test.tsx`: bars and a line per row, the hidden SVG, the data
  table with the declared headers in both languages, a long label cut on the picture and whole in
  its title and the table, a finite scale at ±10¹⁵, and each mismatch sentence.
- `apps/web/components/run/run-result-card.test.tsx`: the charts of the pinned version only, each
  once; nothing for an untyped, unanswered or unversioned run, for no chart, and for `403` and
  `404`; a failed read with a working retry.

## Amendment — the Agent Store shows the chart (unit G2b, 2026-11-21)

The open gap of D5 is closed for the Agent Store's Try it section; the hosted chat still shows no
chart.

- **Where the schema lives.** A store run's `outputSchema` is the catalog entry's
  `demo.outputSchema`, as the use-case plan (§3.1) places it: a run's request, not part of the
  version, so it cannot come from the surface (D2). The catalog validates it as data (a JSON object
  whose root `type` is `object`), never as code. It repeats the schema of the demo agent's eval
  case tagged `suggested` instead of being read from the eval file, because the catalog reads
  nothing outside its folder; `tests/store/result-charts.test.ts` fails when the two differ, when
  the schema breaks the limits of ADR-0143 (`outputSchemaViolation`), and when a chart's `field` is
  not an array of rows holding its `label` and `value` keys. That last check is the static
  counterpart of the mismatch D3 shows, which a surface alone cannot make.
- **Where the charts come from.** The same test reads `resultCharts` from the surfaces of the
  entry's source that name its demo agent (D1: in file order, each chart once) and writes
  `examples/store/catalog/charts.generated.ts`; a stale file fails. The Try it section parses it
  with `ResultChartsSchema` before it draws.
- **How it is shown.** The demo chat starts each run with the entry's schema, keeps
  `run.output.structured` and draws `<ResultChart/>` under the answer, unchanged. A recorded turn
  keeps `structured` (optional, so a turn of an untyped run is unchanged), and the replay draws the
  same charts, so a recording and a screenshot show them; every recorder starts its run with the
  schema, and the recordings test fails when a charted entry's recording has no typed answer.
- **What a visitor sees when it does not fit.** Unlike the console's card (D5), the store leaves out
  a chart the output does not fit: the mismatch sentence speaks to the agent's developer. A run
  whose answer missed its schema (`output_schema_unsatisfied`) is a demo fallback of its own,
  `format` in `DEMO_FALLBACK_REASONS`, worded for the visitor in both languages beside the
  entry's recording.
