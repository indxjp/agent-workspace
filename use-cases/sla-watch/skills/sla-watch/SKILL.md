---
name: sla-watch
description: Which tickets are past or close to their SLA, and how the daily report is laid out.
---

# The helpdesk export

`tickets.csv` in the `sla-watch` folder is a helpdesk view exported as CSV, one row per ticket, with
its `subject`, `organization`, `priority`, `status`, `assignee`, `created_at`, `sla_metric` (first
reply or resolution), `sla_due_at`, `sla_remaining_min` and `last_update`. The helpdesk computes
`sla_remaining_min` when it exports: the minutes left before the deadline, negative once it has
passed. The minutes are as of the export time, not the time you read them. Times are Japan time.

# The rules

- Leave out a ticket whose `status` is `Solved` or `Closed` (解決済み / 終了), and a `Pending`
  (保留) ticket: it waits for the customer and its SLA clock is paused (`sla_remaining_min` empty).
- **Over**: `sla_remaining_min` is 0 or less.
- **Near**: `sla_remaining_min` is more than 0 and at most 240.
- Leave out every other ticket.

Take the minutes as the export holds them; never compute them from the times.

# Owner and next step

The owner is the `assignee`. With none, the owner is "unassigned" (未割当) and the next step is to
assign one. Else the next step answers `last_update`: the reply that is due, the answer awaited, the
check to make. When `last_update` records no progress, the next step is to update the ticket. Never
promise the customer a time or a fix.

# The file

One Markdown file, `sla-watch-reports/<date>.md` (`<date>-<assignee>.md` when narrowed to one assignee), in the language of the request: a `#` heading with the
date and a line saying the minutes are as of the export (naming the export time when the export
holds one, else saying it does not), a `## Over` section and a `## Near` section (超過 / 期限間近), each a table ordered by minutes
left (fewest first) with the ticket, subject, priority, minutes left, owner, next step and source
as `file#id` (for example `tickets.csv#T-5201`).
