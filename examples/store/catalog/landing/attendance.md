# ja

## headline

打刻データと月次集計から、打刻漏れと残業の上限への接近を毎週見つけ、上長が読む報告を上長ごとにまとめて作る。人の評価はしない。

## audience

部下の勤怠を確認する現場の上長、勤怠の締めと労務を担当する人事の担当者

## problem

週の初めに、人事の担当者が勤怠システムから打刻データを出し、打刻漏れと残業の多い人を探して、上長ごとに連絡している。休暇の日を打刻漏れと見間違えたり、上限に近い人への連絡が遅れたりする。

## steps

1. [] 受け取る：毎週月曜の朝に自動で始まる。担当者が週を指定して頼むこともできる。
2. [] 調べる：打刻データと月次集計、勤怠チェックのルールを読む。
3. [] 判断する：ルールに当てはまる打刻漏れと、残業の当月累計が上限に近い人・超えた人だけを、該当する行の出典付きで上長ごとにまとめる。人の評価はしない。
4. [] 人が確認する：保存する前に、担当者の承認を待つ。
5. [] 書き込む：承認された一回の保存で、勤怠チェックを報告のフォルダに書く。

## outputs

- 上長ごとの打刻漏れと残業の状況を、打刻データと月次集計の行の出典付きで並べた勤怠チェック（Markdown）
- 週・上長・該当する人ごとの型付きの結果
- 従わなかった記録の中の指示があれば、その一文

## faq

### 勤怠の悪い人の順位や、処分の対象者を出せますか？

出しません。点数・順位・人どうしの比較・処分や評価への影響の提案は、頼まれてもしません。勤怠チェックは打刻の修正と業務量の調整のためのもので、判断は上長と人事が行います。

### 休暇の理由や体調も報告に入りますか？

入りません。休暇の日は打刻漏れとして扱わず、打刻データの備考に休暇の理由や体調が書かれていても、報告には書きません。

### 自社の勤怠システムや残業のルールに合わせられますか？

打刻データと月次集計は勤怠システムから出したファイルを、ルールは自社のフォルダに置くファイルを読みます。差し替えると、そのルールで確認します。

## limits

- 人に点数・順位をつけず、比べず、処分や評価への影響を提案しない。判断は人が行う。
- 休暇の理由や体調など、私的な事情を書かない。
- 打刻を修正したり、勤怠システムを書き換えたりしない。
- 本人や上長にメールやチャットで連絡しない。

# en

## headline

Finds missed clock-ins and overtime nearing the agreed limit each week from the timeclock export and the monthly summary, and writes a report for managers to read, grouped by manager. It never rates anyone.

## audience

Line managers who check their team's attendance, and HR staff who close attendance and handle labour matters

## problem

At the start of each week, someone in HR exports the timeclock data, looks for missed punches and people with a lot of overtime, and contacts each manager. A day of leave is mistaken for a missed punch, or a warning to someone near the limit comes late.

## steps

1. [] Receive: starts automatically every Monday morning, or when a person asks for a given week.
2. [] Look up: reads the timeclock export, the monthly summary and the attendance check rules.
3. [] Decide: lists, for each manager, only the missed punches the rules define and the people whose month-to-date overtime is near or over the limit, each with its source row. It rates nobody.
4. [] A person confirms: waits for approval before saving.
5. [] Write: saves the attendance check to the reports folder in the one approved call.

## outputs

- An attendance check in Markdown: each manager's missed punches and overtime, with the timeclock and summary rows as sources
- A typed result by week, manager and person concerned
- One sentence about any instruction in the records that it did not follow

## faq

### Can it rank people with poor attendance, or list who to discipline?

No. It never gives a score, a rank, a comparison between people or a suggestion of discipline or an effect on an evaluation, even when asked. The check is for correcting punches and adjusting workloads, and managers and HR decide.

### Does the report include reasons for leave or health matters?

No. A day of leave is never a missed punch, and even when a note in the export gives a reason for leave or a health matter, the report leaves it out.

### Can it use our own attendance system and overtime rules?

It reads the timeclock export and monthly summary from your attendance system, and the rules from a file in your own folder. Replace them and it checks against your rules.

## limits

- Never scores, ranks or compares people, or suggests discipline or an effect on an evaluation: a person decides.
- Never writes reasons for leave, health or other private matters.
- Never corrects a punch or changes the attendance system.
- Never contacts staff or managers by email or chat.
