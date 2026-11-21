# ja

## headline

部門経費の予算と実績を月ごとに比べ、差の大きい行をグラフと計算どおりの数値で示す。

## audience

経理・経営企画の担当者、自部門の予算を管理する部門長

## problem

月次の締めのあと、会計システムから書き出した予実の表を担当者が表計算ソフトで並べ替え、差異と差異率を計算して、説明の要る行を探している。計算式のずれや転記の誤りが混じりやすく、部門ごとのコメントを集めるのにも手間がかかる。

## steps

1. [] 受け取る：会計システムから書き出した、部門・勘定科目・月ごとの予算と実績のCSVを受け取る。
2. [] 調べる：指定された月の行と、期首からその月までの行を読み取る。
3. [] 判断する：決まった計算をするスクリプトが、差異・差異率・累計を求め、基準を超えた行と予算のない支出に印を付ける。
4. [] 人が確認する：差異の大きい行と部門別のグラフを、担当者が確かめる。
5. [] 書き込む：ファイルは書き込まず、結果を表とコメントで返す。

## outputs

- 基準を超えた行の一覧：部門、勘定科目、予算、実績、差異、差異率、期首からの累計の差異
- 部門別の当月の差異の棒グラフと、月別の差異の折れ線グラフ
- スクリプトが出した数値だけを引用したコメント

## faq

### いつ使えるようになりますか？

まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。

### 数値をAIが計算するのですか？

いいえ。差異・差異率・累計は、決まった計算をするスクリプトが求めます。AIはその結果を読んで説明するだけで、スクリプトが出していない数値は書きません。

### 自社の会計システムの書き出しを使えますか？

年月・部門・勘定科目・予算・実績の列があるCSV（UTF-8）か、Excelのファイル（.xlsx、最初のシート）を読みます。列名は日本語と英語のどちらでも構いません。年月は「2026-09」のような文字列にしてください。Excelが日付として保存した年月は読まずに、その列を文字列にするようお願いします。

### 印を付ける基準は変えられますか？

依頼の中で基準となる差異率を伝えると、その基準で印を付けます。伝えないときは決まった基準を使います。

## limits

- 差異の原因を推測せず、分かる数値だけを示す。
- 予算の承認や修正、会計システムへの登録はしない。
- 予実のファイルを書き換えたり、保存したり、送ったりしない。
- 読めない値（空欄、整数でない金額、エラーのセル、結合されたセルの金額など）があれば推測せず、計算せずにその行と列を伝える。

# en

## headline

Compares each department's expense budget with its actuals month by month, and shows the lines that are furthest off with a chart and exactly the computed numbers.

## audience

Accounting and financial planning staff, and department heads who manage their own budget

## problem

After each month-end close, someone exports the budget-versus-actual table from the accounting system, sorts it in a spreadsheet, works out each variance and variance rate, and looks for the lines that need an explanation. Formula slips and copy errors creep in, and collecting each department's comments takes time.

## steps

1. [] Receive: takes the CSV of budget and actual by department, account and month that your accounting system exports.
2. [] Look up: reads the rows of the month asked for, and every row from the start of the year to that month.
3. [] Decide: a script that computes by fixed rules works out variance, variance rate and year to date, and flags the lines over the threshold and any spending with no budget.
4. [] A person confirms: a person checks the lines that are furthest off and the chart by department.
5. [] Write: writes no file, and returns the result as a table and commentary.

## outputs

- A list of the flagged lines: department, account, budget, actual, variance, variance rate and year-to-date variance
- A bar chart of each department's variance for the month, and a line chart of the variance month by month
- Commentary that quotes only numbers the script printed

## faq

### When can I use it?

It is not live yet. Sign up for a launch notice and we will email you when it opens.

### Does the AI do the arithmetic?

No. A script that computes by fixed rules works out the variance, the variance rate and the year to date. The AI reads its result and explains it, and never writes a number the script did not print.

### Can it read our accounting system's export?

It reads a CSV (UTF-8) or an Excel file (.xlsx, its first sheet) with columns for the month, department, account, budget and actual, named in Japanese or English. The month column must be text like "2026-09": a month Excel stored as a date is not read, and it asks you to format that column as text.

### Can I change the threshold for flagging a line?

Name a variance rate in your request and it flags lines by that threshold. Otherwise it uses its default.

## limits

- Never guesses why a variance happened; shows only the numbers it can compute.
- Never approves or changes a budget, and never records anything in the accounting system.
- Never changes, saves or sends the budget files.
- Never guesses a value it cannot read (an empty cell, an amount that is not whole yen, an error cell, an amount in merged cells): it computes nothing and names the row and column.
