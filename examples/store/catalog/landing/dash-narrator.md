# ja

## headline

ダッシュボードの裏にあるデータから、各グラフの動きと平均から大きく離れた点を計算どおりの数値で説明し、確認すべき点を挙げる。

## audience

ダッシュボードを毎週読む事業部の担当者、数値を報告する企画・分析の担当者

## problem

ダッシュボードのグラフは並んでいても、どこがいつもと違うのかを読み取り、会議や報告のために文章にするのは担当者の仕事になっている。山や谷を目で探すと見落としが出やすく、計測の欠落のような確認すべき点に気づくのが遅れることもある。

## steps

1. [] 受け取る：BIツールから書き出した、日付・指標・値のCSVを受け取る。
2. [] 調べる：指定された期間の行を指標ごとに読み取る。
3. [] 判断する：決まった計算をするスクリプトが、指標ごとの最初と最後の値、変化と変化率、平均、山と谷を求め、平均から大きく離れた点に印を付ける。
4. [] 人が確認する：印の付いた点と確認すべき点を、担当者が確かめる。
5. [] 書き込む：ファイルは書き込まず、結果を表と解説で返す。

## outputs

- 指標ごとの表：最初と最後の値、変化、変化率、平均、山と谷とその日付
- 平均から大きく離れた点の一覧と、指標別の変化率の棒グラフ
- スクリプトが出した数値だけを引用した解説と、確認すべき点

## faq

### 数値をAIが計算するのですか？

いいえ。変化・変化率・平均・平均から離れた点は、決まった計算をするスクリプトが求めます。AIはその結果を読んで説明するだけで、スクリプトが出していない数値は書きません。

### 自社のダッシュボードのデータを使えますか？

日付・指標・値の列があるCSV（UTF-8）か、Excelのファイル（.xlsx、最初のシート）を読みます。列名は日本語と英語のどちらでも構いません。

### 数値が動いた理由も教えてくれますか？

理由は断定しません。値がほぼゼロの日は計測が止まっていないか、複数の指標が同じ日に跳ねていればキャンペーンと重なっていないか、といった確認すべき点を挙げ、判断は担当者に任せます。

### 期間を絞れますか？

依頼の中で期間を伝えると、その期間だけを計算します。伝えないときは、ファイルにあるすべての日付を使います。

## limits

- 数値が動いた理由を推測せず、確認すべき点として示す。
- ダッシュボードやグラフの変更、公開はしない。
- データのファイルを書き換えたり、保存したり、送ったりしない。
- 読めない値（空欄、数値でない値、存在しない日付、重複した行など）があれば推測せず、計算せずにその行を伝え、分かるときは列も伝える。

# en

## headline

Explains, from the data behind a dashboard, how each chart moved and which points sit far from the usual, with exactly the computed numbers, and lists what to check.

## audience

Business staff who read a dashboard every week, and planning and analytics staff who report its numbers

## problem

The charts are all on the dashboard, but someone still has to spot what is different from usual and write it up for the meeting or the report. Scanning for peaks and dips by eye misses things, and a point worth checking, such as a gap in the measurement, can go unnoticed for a while.

## steps

1. [] Receive: takes the CSV of date, metric and value that your BI tool exports.
2. [] Look up: reads the rows of the period asked for, metric by metric.
3. [] Decide: a script that computes by fixed rules works out each metric's first and last value, change, change rate, mean, peak and low, and flags the points far from the mean.
4. [] A person confirms: a person checks the flagged points and what to check.
5. [] Write: writes no file, and returns the result as a table and an explanation.

## outputs

- A table per metric: first and last value, change, change rate, mean, and the peak and low with their dates
- A list of the points far from the mean, and a bar chart of each metric's change rate
- An explanation that quotes only numbers the script printed, and what to check

## faq

### Does the AI do the arithmetic?

No. A script that computes by fixed rules works out the change, the change rate, the mean and the points far from it. The AI reads its result and explains it, and never writes a number the script did not print.

### Can it read our own dashboard's data?

It reads a CSV (UTF-8) or an Excel file (.xlsx, its first sheet) with columns for the date, the metric and the value, named in Japanese or English.

### Does it tell me why a number moved?

It never asserts a cause. It lists what to check, such as whether the measurement stopped on a day near zero, or whether a campaign fell on a day when several metrics jumped together, and leaves the judgement to a person.

### Can I narrow the period?

Name a period in your request and it computes that period only. Otherwise it uses every date in the file.

## limits

- Never guesses why a number moved; shows what to check instead.
- Never changes or publishes a dashboard or a chart.
- Never changes, saves or sends the data files.
- Never guesses a value it cannot read (an empty cell, a value that is not a number, a date that does not exist, a repeated row): it computes nothing and names the row, and the column when it can.
