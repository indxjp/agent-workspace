# ja

## headline

顧客一覧から都道府県ごとの売上と訪問回数を集計し、均等に分けたエリア案を計算どおりの数値とグラフで示す。

## audience

営業企画の担当者、営業チームのマネージャー

## problem

期の変わり目に、CRMから顧客一覧を書き出し、都道府県ごとに売上や訪問回数を集計して、偏りのないようにエリアを組み替えている。集計表の手作業は誤りが混じりやすく、組み合わせを何通りも試すうちに、どの案がどれだけ均等なのかが分かりにくくなる。

## steps

1. [] 受け取る：CRMから書き出した、顧客ごとの都道府県・年間売上・訪問回数のCSVを受け取る。
2. [] 調べる：都道府県ごとに顧客数・売上・訪問回数を集計する。
3. [] 判断する：決まった規則で計算するスクリプトが、指定された数のエリアに、売上・訪問回数・顧客数のいずれかが均等になるよう都道府県を割り振る。
4. [] 人が確認する：エリア案と、どのエリアを誰が受け持つかは、担当者が決める。
5. [] 書き込む：ファイルやCRMは書き込まず、結果を表とコメントで返す。

## outputs

- エリア案の一覧：エリア、含まれる都道府県、顧客数、年間売上、訪問回数、全体に占める割合
- 最も大きいエリアと最も小さいエリアの差
- エリア別の棒グラフ

## faq

### 営業担当者の成績を比べたり、順位を付けたりできますか？

いいえ。エリアの配分案だけを作り、人を点数化・順位づけ・比較しません。どのエリアを誰が受け持つかも提案せず、担当者が決めます。

### 何を基準に均等にしますか？

年間売上を基準にします。依頼の中で訪問回数や顧客数を指定すると、その基準で分けます。エリアの数も依頼の中で指定できます。

### 地理的な近さや移動時間は考えますか？

いいえ。都道府県を単位にまとめ、選んだ基準の値が均等になるように割り振るだけです。離れた地域が同じエリアに入ることがあるため、案は担当者が確かめます。

### どんな形式のデータを読めますか？

顧客ID・顧客名・都道府県・年間売上・訪問回数・備考の列があるCSV（UTF-8）か、Excelのファイル（.xlsx、最初のシート）を読みます。列名は日本語と英語のどちらでも構いません。

## limits

- 営業担当者を点数化・順位づけ・比較せず、誰がどのエリアを受け持つかも決めない。
- 地理的な近さや移動時間は考えず、都道府県を単位に数値だけで分ける。
- 顧客一覧やCRMを書き換えたり、保存したり、送ったりしない。
- 読めない値（空欄、数値でない値、負の値、重複した顧客IDなど）があれば推測せず、計算せずにその行を伝える。

# en

## headline

Totals sales and visits by prefecture from your customer list, and proposes an even split into territories with exactly the computed numbers and a chart.

## audience

Sales operations staff and sales team managers

## problem

At the turn of each period, someone exports the customer list from the CRM, totals sales and visits by prefecture, and reshuffles the territories so that none is lopsided. Manual tallying lets errors creep in, and after trying several combinations it is hard to tell how even each option really is.

## steps

1. [] Receive: takes the CSV of each customer's prefecture, annual sales and visits that your CRM exports.
2. [] Look up: totals the customers, sales and visits of each prefecture.
3. [] Decide: a script that computes by fixed rules places the prefectures into the number of territories asked for, so that sales, visits or the number of customers come out even.
4. [] A person confirms: a person decides the territories and who covers each one.
5. [] Write: writes nothing to a file or the CRM, and returns the result as a table and commentary.

## outputs

- The proposed territories: territory, its prefectures, customers, annual sales, visits and share of the total
- The difference between the largest and the smallest territory
- A bar chart by territory

## faq

### Can it compare or rank the salespeople?

No. It proposes territory splits only, and never scores, ranks or compares a person. It does not suggest who should cover a territory either; a person decides.

### What does it balance?

Annual sales. Name visits or the number of customers in your request and it balances that instead. You can name the number of territories too.

### Does it consider distance or travel time?

No. It keeps whole prefectures together and only evens out the measure you chose, so distant areas can share a territory. A person checks the proposal.

### What data can it read?

A CSV (UTF-8) or an Excel file (.xlsx, its first sheet) with columns for the customer id, customer, prefecture, annual sales, visits and note, named in Japanese or English.

## limits

- Never scores, ranks or compares a salesperson, and never decides who covers a territory.
- Never considers distance or travel time; it splits whole prefectures by numbers alone.
- Never changes, saves or sends the customer list or anything in the CRM.
- Never guesses a value it cannot read (an empty cell, a value that is not a number, a negative value, a repeated customer id): it computes nothing and names the row.
