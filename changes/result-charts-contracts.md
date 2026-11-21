---
changelog: contracts
section: Added
---

- `SurfaceDefinitionSchema.resultCharts` (ADR-0168): 1–4 charts a run's result card draws from the
  run's typed output. `ResultChartSchema` names a `kind` (`bar` or `line`, `RESULT_CHART_KINDS`),
  the output's array `field`, each row's `label` and `value` keys, and a bilingual `title` and
  `axes`. `resultChartData(chart, structured)` reads the points, or a `mismatch` reason
  (`no_field`, `empty`, `too_many_rows` over `RESULT_CHART_POINTS_MAX` rows, or `bad_row`, which
  includes a value beyond ±`RESULT_CHART_VALUE_MAX`). Exported from
  `@indx-workspace/contracts/surfaces`.
