---
name: close
description: How the month-end close progress report reads the close checklist export, which tasks count as stuck, and how the report is laid out.
---

# The close exports

The files in the `close` folder are a close management tool's CSV exports.

- `close-tasks.csv`: one row per close task, with the columns
  `task_id, period, workday, task, owner, due_date, status, blocked_by, note`. `status` is
  `完了` / `Done`, `進行中` / `In progress`, `未着手` / `Not started` or `停止中` / `Blocked`;
  `blocked_by` says what a blocked task waits for.
- `close-summary.csv`: the tool's counts, with the columns
  `as_of, period, scope, total, done, in_progress, not_started, blocked, overdue`: one row for the
  whole close (`全体` / `All`) and one per owner. `overdue` counts the tasks past their due date
  and not done.

# Progress

Quote the summary row of the report's scope (the whole close, or the owner when narrowed) as it
stands, with its `as_of` date. When `as_of` is not the report date, say the counts are as of that
date. Never count the tasks yourself or compute a percentage.

# Which tasks are stuck

- **Blocked**: `status` is blocked. The reason is `blocked_by`.
- **Late**: `due_date` is before the report date and `status` is not done. The reason is the note,
  or "no reason recorded" when it is empty.
- A task that is both is listed once as blocked, and says it is late too.
- A task due on the report date or later and not blocked is not stuck. A done task is never listed,
  whatever its note says.

# The next step

One step for the task's owner that answers the reason: chase the document it waits for, ask the
team it waits on, or agree a new date with the close lead. It never posts, reverses or approves an
entry, and never marks a task done: those are the accountants' to do in their own systems.

# The file

One Markdown file, `close-reports/<date>.md` (`<date>-<task id>.md` when narrowed, the owner's first `task_id`), in the language
of the request: a `#` heading with the period and the report date, a progress line with the
summary's counts, then one `##` section per stuck task (blocked first, then late, by due date), each
with the task, the owner, the due date, the status, the reason, the next step and the source as
`file#id` (for example `close-tasks.csv#CL-03`, `close-summary.csv#全体`).
