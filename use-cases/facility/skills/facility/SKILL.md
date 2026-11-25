---
name: facility
description: 会議室や社用車の予約の依頼を、設備予約の決まりに照らして一件の予約にする決まり。どの設備を、いつからいつまで、誰の名前で、何のために。The rules for turning a room or pool car request into one booking the rules allow: which resource, from when to when, for whom and why.
---

# 予約の案にする決まり / Rules for the proposal

決まりは `facility-rules.md` の FAC-01〜FAC-06。書かれたとおりに当てはめ、決まりにない判断はしない。
The rules are FAC-01 to FAC-06 in `facility-rules.md`. Apply them as written; decide nothing they do
not say.

1. 種類と定員 / Type and capacity: 依頼の種類（会議室か社用車か）の設備を `resources.csv` から選び、
   人数が定員以内のものだけを候補にする（FAC-02）。RM-03 は候補にしない（FAC-04）。
   Pick resources of the requested type from `resources.csv` whose capacity covers the head count;
   never RM-03.
2. 時間 / Time: 開始と終了は依頼の日時をそのまま使い、`+09:00` を付けた ISO 8601 で書く。予約できる時間と
   長さ（FAC-01）の中にあるかを確かめる。日時を推測しない。 Copy the requested date and times,
   written as ISO 8601 with `+09:00`; check them against FAC-01. Never guess a time.
3. 重なり / Overlaps: 候補の設備ごとに `bookings.csv` と `list_bookings` を見る。同じ設備で、既存の予約の
   開始が依頼の終了より前で、終了が依頼の開始より後なら重なる。重なる設備は外し、設備IDの小さい順に、
   残った最初の設備を案にする（FAC-05）。 For each candidate, check `bookings.csv` and
   `list_bookings`: a booking overlaps when it starts before the requested end and ends after the
   requested start. Drop overlapping resources and propose the first remaining one by resource ID.
4. 社用車の予約者 / Pool car driver: 予約者が `drivers.csv` に運転許可「あり」で載り、使う日が許可の期限の
   日以前であること（FAC-03）。 The person is in `drivers.csv` with a permit valid on the day.
5. 一件ずつ / One at a time: 一つの設備の一つの時間帯が一件（FAC-06）。 One resource, one span per call.
6. 根拠 / Source: 表の各行に、当てはめた決まり（FAC-0n）と、重なりを確かめた予約ID（BK-xxxx）があれば
   それを示す。 Each row names the rules it rests on, and the booking IDs it checked for overlaps.
