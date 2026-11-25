# ja

## headline

業務データへの質問を読み取り専用のSQLにし、テーブルの書き出しで同じ集計を計算して、表とグラフで返す。

## audience

営業企画・経理・情報システムの担当者など、データベースの数字を確かめたい人

## problem

「先月の地域別の売上は？」といった質問のたびに、SQLを書ける人に依頼して待つか、表計算ソフトで書き出しを集計し直している。依頼の行き来に時間がかかり、取消を除くかどうかといった条件の取り違えも起きやすい。

## steps

1. [] 受け取る：テーブルの書き出し（CSV）と、そのスキーマ（CREATE TABLE文とコメント）を受け取る。
2. [] 調べる：スキーマから、テーブル名・列・値の意味と、集計の決まりを読み取る。
3. [] 判断する：決まった規則で動くスクリプトが、質問を読み取り専用のSELECT文にし、同じ集計を書き出しのデータで計算する。
4. [] 人が確認する：SQLと結果を確かめ、データベースで実行するかは担当者が決める。
5. [] 書き込む：データベースにもファイルにも書き込まず、SQLと結果の表を返す。

## outputs

- 読み取り専用のSELECT文
- グループごとの合計または件数の表と、読んだ行・条件に合った行の数
- 結果の棒グラフ

## faq

### データベースに接続して実行しますか？

いいえ。データベースには接続せず、書き出したデータで同じ集計を計算します。SQLをデータベースで実行するかどうかは、担当者が決めます。

### データを変更するSQLも作れますか？

いいえ。提案するのは読み取りのSELECT文だけです。データの追加・更新・削除や、テーブルの変更をする文は書きません。

### どんな質問に答えられますか？

一つの列ごとの合計や件数に、値の一致・除外と月の条件を付けた集計に答えます。テーブルの結合や平均など、スクリプトで計算できない質問には数値を出さず、その旨を伝えます。

### どんな形式のデータを読めますか？

データベースの列名を見出しにしたCSV（UTF-8）か、Excelのファイル（.xlsx、最初のシート）と、テーブルの定義を書いたスキーマを読みます。

## limits

- データベースに接続せず、SQLを実行しない。
- データを追加・更新・削除したり、テーブルを変更したりする文は書かない。
- 結合や平均など、スクリプトで計算できない集計の数値は出さない。
- 読めない値（空欄、数値でない金額、存在しない日付など）や、ない列があれば推測せず、計算せずにその行と列を伝える。

# en

## headline

Turns a question about your business data into a read-only SQL query, computes the same aggregate from the table's export, and returns a table and a chart.

## audience

Sales planning, accounting and IT staff, and anyone who needs to check a number in a database

## problem

Every question like "what were last month's sales by region?" means asking someone who writes SQL and waiting, or re-totalling an export in a spreadsheet. The back and forth takes time, and conditions such as whether to leave out cancelled orders are easy to get wrong.

## steps

1. [] Receive: takes an export of the table (CSV) and its schema (the CREATE TABLE statement with comments).
2. [] Look up: reads the table name, the columns, what their values mean and the rules for totals from the schema.
3. [] Decide: a script that works by fixed rules turns the question into a read-only SELECT statement and computes the same aggregate from the exported data.
4. [] A person confirms: a person checks the SQL and the result, and decides whether to run it on the database.
5. [] Write: writes nothing to the database or a file, and returns the SQL and a table of the result.

## outputs

- A read-only SELECT statement
- A table of each group's total or count, and the rows read and kept
- A bar chart of the result

## faq

### Does it connect to the database and run the query?

No. It never connects to a database; it computes the same aggregate from the exported data. A person decides whether to run the SQL on the database.

### Can it write SQL that changes data?

No. It proposes read-only SELECT statements only, and never writes a statement that inserts, updates or deletes data or changes a table.

### Which questions can it answer?

A total or a count by one column, with conditions that match or leave out a value and a month. For a question the script cannot compute, such as a join or an average, it gives no number and says so.

### What data can it read?

A CSV (UTF-8) or an Excel file (.xlsx, its first sheet) headed with the database's column names, and a schema that defines the table.

## limits

- Never connects to a database or runs SQL.
- Never writes a statement that inserts, updates or deletes data or changes a table.
- Gives no number for an aggregate the script cannot compute, such as a join or an average.
- Never guesses a value it cannot read (an empty cell, an amount that is not a number, a date that does not exist) or a column that is missing: it computes nothing and names the row and column.
