---
name: handover
description: The sections of a handover pack (overview, cases in progress, routine work, done, contacts, open points) and which task list, threads, procedures and contacts each draws on.
---

# The sources

- `TASKS_*.csv`: the task list, `task_id, title, status, due, next_action`. A status of 進行中 /
  in progress or 未着手 / not started is a case in progress, 定例 / routine is routine work and
  完了 / done is done.
- `THREAD-xx_*.md`: mail or chat threads, one dated message per item.
- `PROC-xx_*.md`: a procedure, as numbered steps.
- `CONTACTS_*.csv`: the contacts, `company, name, role, email, phone`.
- The request in `notes/` (`NOTES`): who hands over to whom, the date and the document name.

# The sections, in order

1. **Overview** (`概要`): who hands over, who takes over, from which date, as the request says.
2. **Cases in progress** (`進行中の案件`): a table with the header
   `タスク, 内容, 状態, 期限, 次の対応, 経緯` / `Task, What, Status, Due, Next action, Background`, one
   row per case in progress, every one the task list holds. The background is the thread's facts in
   one or two lines with their dates and figures as written (`1,200個`, `1,150個`); never a
   difference or a total of your own.
3. **Routine work** (`定例業務`): each routine task with its timing and the procedure's steps, in
   order, citing the `PROC-xx`.
4. **Done** (`完了済み`): one line per done task.
5. **Contacts** (`取引先の窓口`): a table with the header `会社, 氏名, 担当, メール, 電話` /
   `Company, Name, Role, Email, Phone`, copied exactly from `CONTACTS`.
6. **Open points** (`確認事項`): what the sources leave open: a reply awaited, an approval still
   needed, a gap not yet explained, each with its source.

Write about the work only. A person appears by name and role as the sources give them, never with an
opinion of how they worked.
