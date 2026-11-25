---
name: meeting-minutes
description: The minutes format (decisions, open issues, to-dos with owner and deadline), and how this skill's script (run_skill_script, minutes.mjs) saves them with every spoken deadline turned into a date.
---

# Minutes

## The format

Keep the headings and their order; the next system reads them.

```md
# 議事録: <会議名>

- 日時: 2026-10-02 10:00〜10:45
- 場所: 第2工場 2F 会議室B（Teams 併用）
- 出席者: 鷺沼 健一 部長、楠瀬 一郎 課長、雛森 美咲 さん、株式会社ハマナス金型 汐入 浩二 様
- 記録: 議事録エージェント（AI作成・要確認）

## 議題

1. …

## 決定事項

1. …（誰が決めたか分かるときは「鷺沼部長決定」と添える）

## 継続課題

- …

## ToDo

| No. | 内容                             | 担当      | 期限             | 根拠（発言）                            |
| --- | -------------------------------- | --------- | ---------------- | --------------------------------------- |
| 1   | ライン3 段取り替え試行計画の作成 | 楠瀬 一郎 | {{due:来週金曜}} | [00:03:24] 来週金曜までに出します       |
| 2   | 来客対応手順の見直し             | 担当未定  | {{due:来月10日}} | [00:05:36] 担当は次回までに決めましょう |
```

In English the headings are `# Minutes: <meeting>`, Date, Place, Attendees, Recorded by,
`## Agenda`, `## Decisions`, `## Open issues` and `## To-dos` (No., Item, Owner, Due, Said).

- **Attendees**: internal people as `name title` (the title is the honorific) or `name さん`
  without one; external people as `company name 様`. Names, departments and titles are the
  member list's, not the transcript's spelling (「楠瀬さん」, 「品証さん」 = 品質保証部).
- **Decisions**: only what was decided (「決定にします」「決めましょう」). What was only discussed or
  wished (「試してみたい」「検討します」「次回継続」) is an open issue.
- **Owner**: only someone who took the item on or agreed when named, as the member list writes
  them. 「誰かが」「営業さんの中で」「次回決めましょう」 is 担当未定 / No owner: never pick the likeliest
  attendee. An external person may own an item; write them with their company and 様.
- **Deadline**: as it was said, in `{{due:<phrase>}}`, the shortest phrase the script knows when
  one fits (明日中 → `{{due:明日}}`, 来週の金曜くらいまで → `{{due:来週金曜}}`, by next Friday →
  `{{due:next friday}}`), otherwise the words as said. With no deadline at all, write `{{due:なし}}`
  / `{{due:none}}`.
- **Said**: the time and a short quote of the words that give the owner and the deadline.
- Numbers (percentages, decibels, days) are written as they were said.

## Saving

Run the script with `run_skill_script`. There is no shell. The minutes are one argument:

```json
{
  "skill": "meeting-minutes",
  "script": "minutes.mjs",
  "args": [
    "meeting-minutes-reports/2026-10-02_生産会議.md",
    "--date",
    "2026-10-02",
    "--text",
    "<the minutes, as Markdown>"
  ]
}
```

`--date` is the meeting date of the transcript, never today. For English minutes add
`--undated "No date"`. The script turns each `{{due:…}}` into a date: a date as written,
明日 / tomorrow, 週明け / early next week (the next Monday), 今週・来週・再来週 + 曜日 / this or next +
weekday (weeks start on Monday), 月末 / end of the month, 来月N日 / the Nth of next month, N日後 / in
N days, N営業日後 / in N business days (weekends skipped, holidays not). The whole phrase must be one of these (来月 / next month is not a weekday). Anything else becomes
`期限未定 (<phrase>)` / `No date (<phrase>)`. It prints `{ written, date, deadlines: [{ said, due }] }`,
and refuses (`{ "error", "message" }`) a date that is not YYYY-MM-DD and a file that exists already.
