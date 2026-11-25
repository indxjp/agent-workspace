---
changelog: react
section: Added
---

- `<ResultChart chart structured locale />` (ADR-0168): one chart a surface declares in
  `resultCharts`, drawn from a run's typed output as inline SVG, with the same rows as a visually
  hidden data table for screen readers and a bilingual sentence when the output does not fit.
  `resultChartGeometry(points)` is its scale. Colours follow the `--accent`, `--muted`, `--border`
  and `--surface` custom properties when the page sets them, else the text colour.
