# ja

## headline

CRMから書き出した商談一覧から、受注済みの金額と確度で加重した商談を合わせ、四半期の着地見込みを計算どおりの数値とグラフで示す。

## audience

営業企画の担当者、四半期の数字に責任を持つ営業マネージャー

## problem

四半期の途中で、担当者がCRMから商談一覧を書き出し、表計算ソフトで受注済みの金額と確度を掛けた見込みを月ごとに足し上げている。式のずれや集計範囲の取り違えが起きやすく、目標との差を説明する資料づくりにも手間がかかる。

## steps

1. [] 受け取る：CRMから書き出した、案件・顧客・ステージ・金額・確度・受注予定月の商談一覧のCSVを受け取る。
2. [] 調べる：指定された四半期に受注予定の案件を読み取る。
3. [] 判断する：決まった計算をするスクリプトが、受注済みの金額、確度で加重した商談の金額、着地見込み、最良ケースと、目標が示されたときは目標との差と達成率を求める。
4. [] 人が確認する：月別の見込みと、加重金額の大きい商談を、担当者が確かめる。
5. [] 書き込む：ファイルは書き込まず、結果を表とコメントで返す。

## outputs

- 四半期の着地見込み：受注済みの金額、加重した商談の金額、最良ケース、失注した案件の数と金額
- 目標を伝えたときの、目標との差と達成率
- 月別の見込みの棒グラフと、商談中の案件ごとの加重金額の棒グラフ
- スクリプトが出した数値だけを引用したコメント

## faq

### 見込みの数値をAIが計算するのですか？

いいえ。受注済みの金額、加重した金額、着地見込みは、決まった計算をするスクリプトが求めます。AIはその結果を読んで説明するだけで、スクリプトが出していない数値は書きません。

### 自社のCRMの書き出しを使えますか？

案件ID・顧客・ステージ・金額・確度・受注予定月の列があるCSV（UTF-8）か、Excelのファイル（.xlsx、最初のシート）を読みます。列名は日本語と英語のどちらでも構いません。ステージは受注・商談中・失注のいずれかで、受注予定月は文字列にしてください。

### 案件が受注できるかどうかも判断しますか？

いいえ。CRMに入っている確度をそのまま使い、確度を見直したり、受注できるかどうかを推測したりはしません。どの案件に力を入れるかは担当者が決めます。

## limits

- 案件が受注できるかどうかを推測せず、確度も書き換えない。
- 見込みのCRMへの登録や、承認の依頼はしない。
- 商談一覧のファイルを書き換えたり、保存したり、送ったりしない。
- 読めない値（知らないステージ、範囲外の確度、空欄、エラーのセルなど）があれば推測せず、計算せずにその行と列を伝える。

# en

## headline

Combines the deals already won with the open deals weighted by their probability, from your CRM's deal export, and shows the quarter's forecast with a chart and exactly the computed numbers.

## audience

Sales operations staff, and sales managers responsible for the quarter's number

## problem

Partway through each quarter, someone exports the deal list from the CRM and adds up, month by month in a spreadsheet, the won amounts and each open deal's amount times its probability. Formula slips and the wrong range creep in, and explaining the gap to the target takes more work.

## steps

1. [] Receive: takes the CSV of deals your CRM exports, with deal, customer, stage, amount, probability and expected close month.
2. [] Look up: reads the deals expected to close in the quarter asked for.
3. [] Decide: a script that computes by fixed rules works out the won amount, the probability-weighted pipeline, the forecast and the best case and, when a target is given, the gap to it and the attainment rate.
4. [] A person confirms: a person checks the forecast by month and the open deals that carry the most weight.
5. [] Write: writes no file, and returns the result as a table and commentary.

## outputs

- The quarter's forecast: the won amount, the weighted pipeline, the best case, and the count and amount of lost deals
- With a target, the gap to it and the attainment rate
- A bar chart of the forecast by month, and a bar chart of each open deal's weighted amount
- Commentary that quotes only numbers the script printed

## faq

### Does the AI work out the forecast?

No. A script that computes by fixed rules works out the won amount, the weighted pipeline and the forecast. The AI reads its result and explains it, and never writes a number the script did not print.

### Can it read our CRM's export?

It reads a CSV (UTF-8) or an Excel file (.xlsx, its first sheet) with columns for the deal id, customer, stage, amount, probability and expected close month, named in Japanese or English. The stage must be won, open or lost, and the close month must be text.

### Does it judge whether a deal will close?

No. It uses the probability already in your CRM as it is, and never changes a probability or guesses whether a deal will close. A person decides which deals to focus on.

## limits

- Never guesses whether a deal will close, and never changes a probability.
- Never records the forecast in the CRM, and never asks anyone for approval.
- Never changes, saves or sends the deal files.
- Never guesses a value it cannot read (an unknown stage, a probability out of range, an empty cell, an error cell): it computes nothing and names the row and column.
