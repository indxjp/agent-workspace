---
name: scheduling
description: 出席者全員が空いている会議枠を、決まりに照らして候補にする決まり。どの枠を、どの順で、誰を出席者にするか。The rules for finding meeting slots in which every attendee is free: which slots, in what order, and who attends.
---

# 候補にする決まり / Rules for the candidates

決まりは `meeting-rules.md` の SCH-01〜SCH-06。書かれたとおりに当てはめ、決まりにない判断はしない。
The rules are SCH-01 to SCH-06 in `meeting-rules.md`. Apply them as written; decide nothing they do
not say.

1. 出席者 / Attendees: 依頼の名前を `members.csv` の氏名と照らし、名簿の氏名をそのまま使う（SCH-04）。
   Match each name in the request to `members.csv` and use the listed name.
2. 枠 / Slots: 期間の平日ごとに、10:00、11:00、13:00、14:00、15:00、16:00 に始まる1時間の枠を、早い順に
   並べる（SCH-01）。時刻を推測しない。 For each weekday in the period, list the hour-long slots
   starting at 10:00, 11:00, 13:00, 14:00, 15:00 and 16:00, earliest first. Never guess a time.
3. 空き / Free: 枠ごとに、出席者の誰かの予定（`busy.csv` と `list_events`）が、枠の終わりより前に始まり、
   枠の始まりより後に終わるなら、その枠は空いていない（SCH-02）。 A slot is not free when any
   attendee has an entry that starts before the slot ends and ends after it starts.
4. 候補 / Candidates: 空いている枠を早い順に三つまで。登録するのは一つ目だけ（SCH-03）。
   Up to three free slots, earliest first; only the first is put on the calendar.
5. 予定の中身 / The event: `title` は依頼の件名、`start` と `end` は `+09:00` を付けた ISO 8601、
   `attendees` は名簿の氏名、`location` は「オンライン」/ "Online"（SCH-05）。メールアドレスは書かない。
   Title from the request, ISO 8601 times with `+09:00`, staff names, "Online"; no email address.
6. 根拠 / Source: 表の各行に、当てはめた決まり（SCH-0n）を示す。 Each row names the rules it rests on.
