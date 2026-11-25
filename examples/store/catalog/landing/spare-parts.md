# ja

## headline

保守部品の在庫と修理での使用実績から、いま発注すべき部品と数量を計算どおりの数値で示す。

## audience

設備保全の担当者、保守部品の在庫を管理する購買・資材の担当者

## problem

保全の担当者が、修理記録から部品ごとの使用数を拾い、在庫一覧と見比べて、切らしそうな部品を経験で判断している。発注残の見落としや発注単位の計算違いが起きやすく、使用が増えている部品に気づくのも遅れがちになる。

## steps

1. [] 受け取る：保全システムから書き出した部品の在庫一覧と、修理記録からの月ごとの部品使用実績のCSVを受け取る。
2. [] 調べる：依頼された期間の使用実績と、部品ごとの在庫・発注残・調達日数・発注単位を読み取る。
3. [] 判断する：決まった計算をするスクリプトが、調達期間とその先のひと月分の使用見込みから発注点を求め、足りない数を発注単位に切り上げ、使用が増えている部品に印を付ける。
4. [] 人が確認する：発注すべき部品と数量、月別の使用数のグラフを、担当者が確かめる。
5. [] 書き込む：発注もファイルの書き込みもせず、結果を表とコメントで返す。

## outputs

- 発注すべき部品の一覧：部品番号、部品名、設備、発注する数量、発注点、手元と発注済みの数
- 部品別の発注数量の棒グラフと、月別の部品使用数の折れ線グラフ
- 使用が増えている部品と、発注済みの分で足りる部品を挙げたコメント

## faq

### 数量をAIが決めるのですか？

いいえ。発注点と発注する数量は、決まった計算をするスクリプトが求めます。AIはその結果を読んで説明するだけで、スクリプトが出していない数値は書きません。発注するかどうかは担当者が決めます。

### 自社の保全システムの書き出しを使えますか？

部品番号・部品名・設備・在庫数・発注残・調達日数・発注単位の列がある在庫一覧と、年月・部品番号・使用数の列がある使用実績を、CSV（UTF-8）かExcelのファイル（.xlsx、最初のシート）で読みます。列名は日本語と英語のどちらでも構いません。

### 直近の期間だけで計算できますか？

依頼の中で直近の何か月分を使うかを伝えると、その期間の使用実績だけで計算します。伝えないときは、使用実績にあるすべての月を使います。

## limits

- 発注や見積の依頼をせず、仕入先にも連絡しない。
- 部品が壊れる原因を推測せず、使用実績から計算できる数値だけを示す。
- 在庫一覧や使用実績のファイルを書き換えたり、保存したり、送ったりしない。
- 読めない値（空欄、整数でない数、在庫一覧にない部品、エラーのセルなど）があれば推測せず、計算せずにその行と列を伝える。

# en

## headline

Shows which spare parts to order now, and how many, from the stock list and the parts used in repairs, with exactly the computed numbers.

## audience

Maintenance engineers, and purchasing or stores staff who manage spare-parts stock

## problem

A maintenance engineer picks each part's use out of the repair records, compares it with the stock list and judges from experience which parts may run out. Orders already placed get missed, order lots get miscounted, and a part whose use is rising is noticed late.

## steps

1. [] Receive: takes the stock list exported from your maintenance system and the monthly parts usage from the repair records, as CSV files.
2. [] Look up: reads the usage over the period asked for, and each part's stock, open orders, lead time and order lot.
3. [] Decide: a script that computes by fixed rules works out each part's reorder point from its expected use over the lead time plus one month, rounds the shortfall up to whole order lots, and flags the parts whose use is rising.
4. [] A person confirms: a person checks the parts to order, the quantities and the chart of use by month.
5. [] Write: places no order and writes no file, and returns the result as a table and commentary.

## outputs

- A list of the parts to order: part number, name, equipment, quantity to order, reorder point, and what is on hand and on order
- A bar chart of the quantity to order by part, and a line chart of the parts used month by month
- Commentary naming the parts whose use is rising and those that open orders already cover

## faq

### Does the AI decide the quantities?

No. A script that computes by fixed rules works out the reorder point and the quantity to order. The AI reads its result and explains it, and never writes a number the script did not print. A person decides whether to order.

### Can it read our maintenance system's export?

It reads a stock list with columns for the part number, name, equipment, stock on hand, open orders, lead time in days and order lot, and a usage log with columns for the month, part number and quantity used, as CSV (UTF-8) or Excel (.xlsx, its first sheet) files, with Japanese or English column names.

### Can it use only the most recent months?

Say in your request how many recent months to use and it computes from those months only. Otherwise it uses every month in the usage log.

## limits

- Never places an order or asks for a quote, and never contacts a supplier.
- Never guesses why a part fails; shows only the numbers it can compute from the usage.
- Never changes, saves or sends the stock list or the usage log.
- Never guesses a value it cannot read (an empty cell, a number that is not whole, a part missing from the stock list, an error cell): it computes nothing and names the row and column.
