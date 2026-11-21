---
name: project-status
description: How each workstream is rated red, amber or green, and how the weekly report is laid out.
---

# The export

The files in the `project-status` folder are a project tool's CSV export, one row per record:

- `tasks.csv`: `task_id`, `workstream`, `title`, `owner`, `status` and `due_date`. A task is open
  unless its `status` is `Done` (完了).
- `milestones.csv`: `milestone_id`, `workstream`, `name`, `due_date`, `forecast_date` (when the
  team now expects it) and `status`.
- `risks.csv`: `risk_id`, `workstream`, `description`, `impact` (High, Medium or Low; 高 / 中 / 低),
  `status` and `mitigation`. A risk is open unless its `status` is `Closed` (クローズ).

# The rating

Take the first rule that holds:

1. **Red**: a milestone's `forecast_date` is after its `due_date`, or an open high-impact risk has
   no `mitigation`.
2. **Amber**: an open task's `due_date` is before the report date, or an open risk is of high or
   medium impact.
3. **Green**: none of the above.

The evidence names each rule that holds, with the dates and values as the export holds them. A
green workstream's evidence says that no rule holds and names its next milestone.

# The file

One Markdown file, `project-status-reports/<date>.md` (`<date>-<workstream>.md` when narrowed to one workstream), in the language of the request: a `#` heading with the
report date, a summary table (workstream, rating, one-line reason), then one `##` section per
workstream (red first) with the evidence, the open risks and the sources as `file#id` (for example
`milestones.csv#MS-01`).
