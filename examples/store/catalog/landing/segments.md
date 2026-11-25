# ja

## headline

注文明細から、最後の注文からの日数と注文回数の決まったルールで顧客をセグメントに分け、セグメントごとの特徴をグラフと計算どおりの数値で示す。

## audience

通販・小売のマーケティング担当者、顧客向けの施策を企画する販売促進の担当者

## problem

担当者が注文データを書き出し、表計算ソフトで顧客ごとに最後の注文日と注文回数をまとめ、自分なりの基準でグループに分けている。基準が担当者や時期によって変わり、どのグループに何を打つかの話し合いが数値の確認から始まってしまう。

## steps

1. [] 受け取る：通販システムから書き出した、注文日・顧客ID・商品カテゴリ・金額の注文明細のCSVを受け取る。
2. [] 調べる：基準日までの注文を顧客ごとにまとめ、最後の注文からの日数と注文回数を読み取る。
3. [] 判断する：決まったルールで計算するスクリプトが、顧客を優良・一般・新規・離反懸念・休眠に分け、セグメントごとの顧客数・売上・売上の割合・平均の注文回数・最も売れたカテゴリを求める。
4. [] 人が確認する：セグメント別の顧客数と売上のグラフ、各セグメントの特徴と施策の案を、担当者が確かめる。
5. [] 書き込む：顧客への連絡もファイルの書き込みもせず、結果を表とコメントで返す。

## outputs

- セグメントごとの顧客数、注文数、売上、売上の割合、平均の注文回数、最後の注文からの平均日数、最も売れたカテゴリ
- セグメント別の顧客数と売上の棒グラフ
- 各セグメントの特徴と、担当者が検討できる施策の案を書いたコメント

## faq

### セグメントはAIが決めるのですか？

いいえ。最後の注文からの日数と注文回数による決まったルールで、スクリプトが分けます。AIはその結果を読んで説明するだけで、顧客を別のセグメントに移したり、スクリプトが出していない数値を書いたりしません。

### 自社の通販システムの書き出しを使えますか？

注文日・顧客ID・商品カテゴリ・金額の列があるCSV（UTF-8）か、Excelのファイル（.xlsx、最初のシート）を読みます。列名は日本語と英語のどちらでも構いません。

### 過去の時点で分けられますか？

依頼の中で日付を伝えると、その日までの注文だけで分けます。伝えないときは、ファイルにある最後の注文日を基準にします。

## limits

- 顧客への連絡やクーポンの送付をしない。
- 個々の顧客を挙げたり評価したりせず、セグメント単位の数値だけを示す。
- 購買行動の理由を推測せず、計算できる数値だけを示す。
- 注文明細のファイルを書き換えたり、保存したり、送ったりしない。

# en

## headline

Groups customers into segments from an order export by fixed rules on days since the last order and number of orders, and shows what marks each segment with charts and exactly the computed numbers.

## audience

E-commerce and retail marketers, and promotion planners who design campaigns for customers

## problem

Someone exports the orders, sums each customer's last order date and number of orders in a spreadsheet, and groups customers by their own yardstick. The yardstick changes with the person and the season, and every discussion of what to do for each group starts by checking the numbers.

## steps

1. [] Receive: takes the order CSV your online shop exports, with the order date, customer ID, product category and amount.
2. [] Look up: gathers each customer's orders up to the day asked for, and reads the days since the last order and the number of orders.
3. [] Decide: a script that applies fixed rules puts each customer in a segment (loyal, regular, new, at risk or lapsed), and works out each segment's customers, revenue, share of revenue, average orders and the category that sells most.
4. [] A person confirms: a person checks the charts of customers and revenue by segment, what marks each segment and the ideas for it.
5. [] Write: contacts no customer and writes no file, and returns the result as a table and commentary.

## outputs

- Per segment: customers, orders, revenue, share of revenue, average orders, average days since the last order and the category that sells most
- Bar charts of customers and of revenue by segment
- Commentary on what marks each segment, with ideas a person may consider

## faq

### Does the AI decide the segments?

No. A script puts each customer in a segment by fixed rules on days since the last order and number of orders. The AI reads its result and explains it, never moves a customer to another segment, and never writes a number the script did not print.

### Can it read our online shop's export?

It reads a CSV (UTF-8) or an Excel file (.xlsx, its first sheet) with columns for the order date, customer ID, product category and amount, named in Japanese or English.

### Can it segment as of an earlier day?

Name a day in your request and it uses only the orders up to that day. Otherwise it uses the last order date in the file.

## limits

- Never contacts customers or sends coupons.
- Never names or judges an individual customer; shows figures by segment only.
- Never guesses why customers buy as they do; shows only the numbers it can compute.
- Never changes, saves or sends the order files.
