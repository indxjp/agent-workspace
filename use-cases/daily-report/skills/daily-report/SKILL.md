---
name: daily-report
description: How the production daily reads the line reports, when a line has an issue, and how the daily is laid out.
---

# The line reports

`line-reports.csv` in the `daily-report` folder is the production system's CSV export of the line
daily reports, one row per line and shift, with the columns
`report_id, date, line, process, shift, leader, planned_min, run_min, utilization_pct, output_qty, defect_qty, stop_min, stop_reason, note`.
The system computes `utilization_pct` (run time over planned time) and `stop_min` when the leader
closes the report. Times are in minutes, quantities in pieces.

# When a line has an issue

- `utilization_pct` is below 90.0, or
- `defect_qty` is 20 or more.

The issue names what the row says: the stop reason and its minutes, the defect count, and the
leader's note when it adds something (a fix made, a check under way). A line with no issue gets one
line with its figures and nothing more.

Quote every figure as the row holds it (`62.5`, not `about 60`). Never add lines up, average them or
compare them with another day: the daily is the day's rows, as they are.

# The file

One Markdown file, `daily-report-reports/<date>.md`, in the language of the request: a `#` heading
with the date, a table with one row per line (line, process, utilization, output, defects, stop
minutes), then an `## Issues` (`## 課題`) section with one bullet per line that has an issue, lines
with the lowest utilization first, each ending with its source as `file#id` (for example
`line-reports.csv#DR-1124-L3`).
