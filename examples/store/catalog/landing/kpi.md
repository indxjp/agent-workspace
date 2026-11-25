# ja

## headline

週次のKPIを前週と比べ、大きく動いた指標を計算どおりの数値とグラフで示す。

## audience

経営企画・事業企画の担当者、毎週の数字を報告するチームのリーダー

## problem

毎週、BIツールや集計表からKPIを書き出し、担当者が前週の数字と並べて増減と増減率を計算し、報告に載せる指標を選んでいる。計算式のずれや転記の誤りが混じりやすく、どの動きを説明すべきかの判断にも時間がかかる。

## steps

1. [] 受け取る：BIツールや集計表から書き出した、週・指標ごとの値のCSVを受け取る。
2. [] 調べる：指定された週と、それより前の週の行を読み取る。
3. [] 判断する：決まった計算をするスクリプトが、前週比・増減率・直近の平均を求め、基準を超えて動いた指標に印を付ける。
4. [] 人が確認する：動いた指標と指標別のグラフを、担当者が確かめる。
5. [] 書き込む：ファイルは書き込まず、結果を表とコメントで返す。

## outputs

- 動いた指標の一覧：指標、今週の値と単位、前週の値、増減、増減率、直近の平均
- 指標別の前週比の棒グラフ
- スクリプトが出した数値だけを引用したコメント

## faq

### 数値をAIが計算するのですか？

いいえ。増減・増減率・平均は、決まった計算をするスクリプトが求めます。AIはその結果を読んで説明するだけで、スクリプトが出していない数値は書きません。

### どんな形式のデータを読めますか？

週・指標・値・単位・備考の列があるCSV（UTF-8）か、Excelのファイル（.xlsx、最初のシート）を読みます。列名は日本語と英語のどちらでも構いません。週はその週の初日を「年-月-日」の形の文字列にしてください。

### 動いたと判断する基準は変えられますか？

依頼の中で基準となる増減率を伝えると、その基準で印を付けます。伝えないときは決まった基準を使います。

## limits

- 数字が動いた原因を推測せず、計算できる数値だけを示す。
- KPIの目標の設定や変更、BIツールやチャットへの登録・投稿はしない。
- KPIのファイルを書き換えたり、保存したり、送ったりしない。
- 読めない値（空欄、数値でない値、エラーのセル、結合されたセルの値など）があれば推測せず、計算せずにその行と列を伝える。

# en

## headline

Compares each weekly KPI with the week before, and shows the metrics that moved with a chart and exactly the computed numbers.

## audience

Corporate and business planning staff, and team leads who report the weekly numbers

## problem

Every week, someone exports the KPIs from the BI tool or a tracking sheet, lines them up against the previous week, works out each change and change rate, and picks the metrics worth reporting. Formula slips and copy errors creep in, and deciding which movements need an explanation takes time.

## steps

1. [] Receive: takes the CSV of values by week and metric that your BI tool or tracking sheet exports.
2. [] Look up: reads the rows of the week asked for and of the weeks before it.
3. [] Decide: a script that computes by fixed rules works out the change on the previous week, the change rate and the recent mean, and flags the metrics that moved past the threshold.
4. [] A person confirms: a person checks the metrics that moved and the chart by metric.
5. [] Write: writes no file, and returns the result as a table and commentary.

## outputs

- A list of the metrics that moved: metric, this week's value and unit, the previous value, change, change rate and recent mean
- A bar chart of each metric's change on the previous week
- Commentary that quotes only numbers the script printed

## faq

### Does the AI do the arithmetic?

No. A script that computes by fixed rules works out the change, the change rate and the mean. The AI reads its result and explains it, and never writes a number the script did not print.

### What data can it read?

It reads a CSV (UTF-8) or an Excel file (.xlsx, its first sheet) with columns for the week, metric, value, unit and note, named in Japanese or English. The week is its first day as text in the form year-month-day.

### Can I change the threshold for a metric that moved?

Name a change rate in your request and it flags metrics by that threshold. Otherwise it uses its default.

## limits

- Never guesses why a number moved; shows only the numbers it can compute.
- Never sets or changes KPI targets, and never records or posts anything in a BI tool or chat.
- Never changes, saves or sends the KPI files.
- Never guesses a value it cannot read (an empty cell, a value that is not a number, an error cell, a value in merged cells): it computes nothing and names the row and column.
