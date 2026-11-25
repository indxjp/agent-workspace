# ja

## headline

過去の値上げ・値下げで数量がどう動いたかから、検討中の価格変更で売上がどう変わるかを、商品ごとにグラフと計算どおりの数値で試算する。

## audience

価格を決める商品企画・営業企画の担当者、売上計画を立てる経営企画の担当者

## problem

価格の見直しのたびに、担当者が過去の売上データを集め、値上げした月の前後で数量がどれだけ動いたかを表計算ソフトで調べている。商品ごとに計算の仕方がそろわず、試算の前提を説明するのにも時間がかかる。

## steps

1. [] 受け取る：販売管理システムから書き出した、月・商品ごとの単価と販売数量のCSVと、検討中の価格の変更率を受け取る。
2. [] 調べる：商品ごとに単価が変わった月を探し、その前後の数量を読み取る。
3. [] 判断する：決まった計算をするスクリプトが、過去の価格変更から商品ごとの価格弾力性を求め、直近の月の単価と数量に当てはめて、新しい単価・数量・売上とその増減を試算する。
4. [] 人が確認する：商品別の売上の増減と月別の売上のグラフを、担当者が確かめる。
5. [] 書き込む：価格の変更もファイルの書き込みもせず、結果を表とコメントで返す。

## outputs

- 商品ごとの価格弾力性、新しい単価、試算した数量と売上、売上の増減（円と割合）と、その合計
- 商品別の売上の増減の棒グラフと、月別の売上の折れ線グラフ
- 売上が下がる商品と上がる商品、過去に価格変更がなく試算できない商品を挙げたコメント

## faq

### これは売上の予測ですか？

いいえ。その商品の過去の価格変更での数量の動きを、直線的に当てはめた試算です。季節、競合、販促などは考えません。価格を決めるのは担当者です。

### 数値をAIが計算するのですか？

いいえ。価格弾力性と試算は、決まった計算をするスクリプトが求めます。AIはその結果を読んで説明するだけで、スクリプトが出していない数値は書かず、商品の合計も自分では足しません。

### 自社の販売管理システムの書き出しを使えますか？

年月・商品コード・商品名・単価・数量の列があるCSV（UTF-8）か、Excelのファイル（.xlsx、最初のシート）を読みます。列名は日本語と英語のどちらでも構いません。

## limits

- 価格を変更したり、販売管理システムに登録したりしない。
- 試算を予測や約束として示さない。
- 競合の価格や市場の情報を調べない。
- 売上のファイルを書き換えたり、保存したり、送ったりしない。

# en

## headline

Estimates, product by product, how the price change you are weighing would move revenue, from how quantities moved at past price increases and cuts, with charts and exactly the computed numbers.

## audience

Product and sales planners who set prices, and corporate planners who build sales plans

## problem

At every price review, someone gathers past sales and checks in a spreadsheet how far quantities moved around the month a price went up. The method differs from product to product, and explaining the assumptions behind an estimate takes time.

## steps

1. [] Receive: takes the CSV of unit price and quantity sold by month and product that your sales system exports, and the change of price being considered.
2. [] Look up: finds the months each product's price changed, and reads the quantities around them.
3. [] Decide: a script that computes by fixed rules works out each product's price elasticity from its past price changes, applies it to the last month's price and quantity, and estimates the new price, quantity and revenue and the change in revenue.
4. [] A person confirms: a person checks the charts of the change in revenue by product and of revenue by month.
5. [] Write: changes no price and writes no file, and returns the result as a table and commentary.

## outputs

- Per product: price elasticity, new price, estimated quantity and revenue, and the change in revenue in yen and as a share, with their total
- A bar chart of the estimated change in revenue by product, and a line chart of revenue by month
- Commentary naming the products whose revenue would fall or rise, and those with no past price change to estimate from

## faq

### Is this a sales forecast?

No. It is a straight-line reading of how each product's quantity moved at its own past price changes, and leaves out seasons, competitors and promotions. A person decides the prices.

### Does the AI do the arithmetic?

No. A script that computes by fixed rules works out the elasticity and the estimate. The AI reads its result and explains it, never writes a number the script did not print, and never adds up the products itself.

### Can it read our sales system's export?

It reads a CSV (UTF-8) or an Excel file (.xlsx, its first sheet) with columns for the month, product code, product name, unit price and quantity, named in Japanese or English.

## limits

- Never changes a price or records anything in the sales system.
- Never presents the estimate as a forecast or a promise.
- Never looks up competitors' prices or market information.
- Never changes, saves or sends the sales files.
