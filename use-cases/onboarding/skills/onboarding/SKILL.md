---
name: onboarding
description: 入社準備のタスクの作り方。チェックリストの項目ごとに件名、担当、期限、備考を決め、人を評価しない。How to turn the onboarding checklist into tasks for one new hire (title, assignee, due date, notes), never judging the person.
---

# 入社準備のタスク / Onboarding tasks

参照フォルダには、日本語の資料が `ja/`、英語の資料が `en/` にある。依頼の言語の資料を使う。
The reference folder holds the Japanese files in `ja/` and the English ones in `en/`. Use the files
in the language of the request.

## 読むもの / What to read

| ファイル / File                | 何がわかるか / What it gives                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `new-hires.csv`                | 入社する人の社員番号、入社日、所属部署、雇用形態、勤務地、上長 / start date, department, type, location, manager |
| `onboarding-checklist.md`      | 項目 ONB-01〜ONB-06 の担当と期限 / owner and due rule of each item ONB-01 to ONB-06                              |
| `policies/account-policy.md`   | 発行するアカウント / which accounts to issue                                                                     |
| `policies/equipment-policy.md` | 貸与する機器と届け先 / which equipment, delivered where                                                          |
| `training-schedule.csv`        | 入社日ごとのオリエンテーション、研修、面談の日 / orientation, training and check-in dates per start date         |

## タスクの作り方 / Building the tasks

入社する人一人につき、ONB-01〜ONB-06 を一件ずつ、合わせて六つのタスクにする。
For one new hire, one task for each of ONB-01 to ONB-06, six tasks in all.

- `title`: チェックリストの形のとおり。 / As the checklist's title format says.
  例 / e.g. `[ONB-01] アカウントの発行：鴫原 灯（2026-12-01 入社）`
- `assignee`: チェックリストの「担当」のとおり。ONB-06 は `new-hires.csv` の上長。 / The checklist's
  owner; for ONB-06 the manager in `new-hires.csv`.
- `due`: チェックリストの「期限」が指す日付を、`new-hires.csv` か `training-schedule.csv` から
  そのまま写す（`YYYY-MM-DD`）。日付を計算しない。該当する行がなければ期限を空けず、その人のタスクは
  登録せずに、該当する日程がないと伝える。 / Copy the date the due rule names from `new-hires.csv` or
  `training-schedule.csv` as written (`YYYY-MM-DD`); never compute a date. When no row matches, create
  none of that person's tasks and say the schedule has no matching date.
- `notes`: 規程で決まった中身。ONB-01 は発行するアカウントの一覧、ONB-02 は機器と届け先、ONB-05 は
  研修の名前と日付。根拠のファイル名を最後に書く。 / What the policy decides: the accounts for ONB-01,
  the equipment and where it goes for ONB-02, the trainings and their dates for ONB-05. End with the
  file it rests on.

## 登録 / Creating them

案を表で示してから、ONB-01 から順に一件ずつ `create_task` を呼ぶ。一回の承認で登録されるのは
その一件だけで、次の一件はまた承認を待つ。登録の前に `list_tasks` で同じ件名のタスクがないか確かめ、
あれば登録しない。
Show the proposal as a table, then call `create_task` once per task, from ONB-01 on. An approval
covers that one task; the next one waits again. Check `list_tasks` for a task with the same title
first, and skip it if there is one.

## 人を評価しない / Never judge the person

入社する人の適性、能力、将来性を評価しない。点数、順位、評語（S〜D、5段階など）を、答えにもタスクにも
書かない。求められたら、評価はしないと一文で伝え、準備のタスクだけを示す。人についての判断は人が行う。
Never assess a new hire's aptitude, ability or potential. Write no score, rank or grade (S to D, one to
five) in the answer or in a task. When asked for one, say in one sentence that you do not assess
people and give only the onboarding tasks. People make every decision about people.
