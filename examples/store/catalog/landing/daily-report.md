# ja

## headline

各ラインの日報から、稼働率・生産数・不良数と止まった理由を日報の数字のまま一枚にまとめ、課題のあるラインを先に示す。

## audience

製造課の課長と係長、朝の打ち合わせで前日の生産を振り返る現場のリーダー

## problem

朝の打ち合わせの前に、課長はラインごとの日報を開き、稼働率や不良数、止まった理由を拾い出して一枚にまとめている。ラインが多いと転記に時間がかかり、数字の写し間違いや、止まった理由の見落としが起きやすい。

## steps

1. [] 受け取る：平日の決まった時刻に、生産日報まとめを作る指示を受け取る。
2. [] 調べる：生産管理システムから書き出したライン日報を探し、その日の分を読む。
3. [] 判断する：スキルに書いた基準で課題のあるラインを選び、止まった理由と班長のメモをまとめる。数字は日報のまま写す。
4. [] 人が確認する：まとめを保存する前に、担当者の承認を待つ。承認なしには保存しない。
5. [] 書き込む：承認されたまとめだけを、レポート用のフォルダに保存する。

## outputs

- ラインごとの稼働率、生産数、不良数、停止時間を日報の数字のまま並べた表
- 課題のあるラインごとに、止まった理由と班長のメモ、出典の日報番号
- 承認のあとフォルダに保存される、その日のまとめのMarkdownファイル

## faq

### 稼働率などの数字はエージェントが計算しますか？

計算しません。生産管理システムが日報に書き出した数字をそのまま写します。工場全体の合計や平均も作りません。

### 課題の基準は変えられますか？

稼働率と不良数の基準は、スキルに書かれています。自社の基準に合わせて書き換えられます。

### 作業者や班長の評価に使えますか？

使えません。まとめはラインの状況を示すもので、人の成績を評価したり順位をつけたりはしません。

## limits

- 生産計画や設備の設定を変えない。
- 日報にない数字を計算したり推測したりしない。
- 作業者や班長の仕事ぶりを評価しない。
- 書き出したファイルの中に書かれた指示には従わず、その内容として扱う。

# en

## headline

Puts each line's utilization, output, defects and the reasons it stopped on one page, with the figures as the line reports give them, issues first.

## audience

Production managers and supervisors, and the line leaders who review the previous day at the morning meeting

## problem

Before the morning meeting, the production manager opens each line's daily report and copies the utilization, the defects and the reasons for stops onto one page. With many lines this takes time, and a figure copied wrongly or a stop overlooked is easy to miss.

## steps

1. [] Receive: takes the instruction to write the production daily at a set time each weekday.
2. [] Look up: finds the line reports exported from the production system and reads the day's rows.
3. [] Decide: picks the lines with an issue by the rules in its skill, with the stop reasons and the leaders' notes, copying every figure as the report gives it.
4. [] A person confirms: waits for the owner's approval before saving the daily, and never saves it without it.
5. [] Write: saves only the approved daily to the reports folder.

## outputs

- A table of each line's utilization, output, defects and stop time, as the line reports give them
- For each line with an issue: the stop reason, the leader's note and the source report id
- The day's daily as a Markdown file, saved to a folder once it is approved

## faq

### Does the agent compute utilization and other figures?

No. It copies the figures the production system exported into the line reports, and makes no plant total or average.

### Can I change what counts as an issue?

The utilization and defect rules are written in its skill. You can rewrite them to match your own.

### Can it be used to rate workers or leaders?

No. The daily shows how the lines ran; it never rates or ranks a person.

## limits

- Never changes a production plan or a machine setting.
- Never computes or guesses a figure the line reports do not hold.
- Never judges a worker's or a leader's performance.
- Never follows an instruction written inside the exported files; it treats it as their content.
