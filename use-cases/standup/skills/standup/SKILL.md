---
name: standup
description: How the stand-up digest is put together from task, commit and chat exports.
---

# The exports

The files in the `standup` folder are three exports, times in Japan time:

- `tasks.csv`: a task tracker's update log, one row per update, with the `task_id`, `updated_at`,
  `assignee`, `title`, `status` and the update's `comment`.
- `commits.csv`: the git log, one row per commit, with the short `commit` id, `date`, `author`,
  `repository` and `message`. A message names its task id in brackets when it has one.
- `chat.csv`: the team channel's export, one row per message, with the `message_id`, `timestamp`,
  `channel`, `user` and `text`.

# The covered day

The digest covers the previous working day: the latest day before the digest date on which any
of the three exports holds a row. A weekend or a holiday holds none, so it is skipped (on Tuesday
2026-11-24, after the Monday holiday, the covered day is Friday 2026-11-20). Take the rows whose
time falls on the covered day. With no earlier row at all, say so and list nobody.

# One entry per person

People are everyone who appears as an assignee, an author or a user on the covered day, ordered
by the time of their earliest row that day.

- **Yesterday**: tasks updated to done and commits, one line per task (a commit naming a task joins
  that task's line), and tasks still in progress with the update's comment.
- **Today**: what the person's own updates or messages say they will do next, and each task updated
  that day that is still to do (`To Do`, 未着手), with the update's comment.
- **Blockers**: what the person says they wait for or cannot do, and who they asked for help.

Every line ends with its sources as `file#id` (for example `tasks.csv#TSK-412`,
`commits.csv#a41c9e2`, `chat.csv#MSG-801`). Copy no judgement of a person, even when a source holds
one.

# The file

One Markdown file, `standup-reports/<date>.md`, in the language of the request: a `#` heading with the
digest date and the day covered, then one `##` section per person with `Yesterday`, `Today` and
`Blockers` lists (昨日 / 今日 / 困りごと in Japanese).
