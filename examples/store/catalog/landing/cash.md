# ja

## headline

入出金の予定と口座残高から、スクリプトが週ごとの収支と週末の残高を計算し、残高が最も低くなる週と最低残高を下回る週を示す。

## audience

資金繰り表を更新する経理・財務の担当者、支払いの時期を判断する管理部門の責任者

## problem

毎週、経理の担当者が会計システムから入出金の予定を書き出し、表計算ソフトで週ごとに足し引きして資金繰り表を作り直している。式のずれや予定の入れ忘れに気づきにくく、残高が足りなくなる週の発見が遅れる。

## steps

1. [] 受け取る：担当者が入出金予定と口座残高のファイルを指定するか、添付して頼む。
2. [] 調べる：自社のフォルダから、指定された入出金予定と口座残高のファイルを見つける。
3. [] 判断する：スクリプトが口座残高の合計を期首とし、週ごとの入金・出金・収支・週末残高、最も低い週、最低残高を下回る週を計算する。
4. [] 人が確認する：計算どおりの数値だけで、表と短い説明を示す。資金の手当てや支払いの時期は担当者が判断する。
5. [] 書き込む：何も書かない。ファイルの変更・保存・送信や支払いはしない。

## outputs

- 週ごとの入金・出金・収支・週末残高の表と、最も低い週と最低残高を下回る週の説明
- 期首残高・週ごとの数値・最も低い週の型付きの結果と、週末残高と収支のグラフ
- 従わなかったファイルの中の指示があれば、その一文

## faq

### 数値はどこから来ますか？

すべてスクリプトの計算結果です。エージェントは自分で足し算や見込みを作らず、スクリプトが出した数値だけを書きます。スクリプトが読めない行があれば、その行を示して計算しません。

### 支払いを外した表を作れますか？

作りません。資金繰り表は入出金予定のファイルのとおりに計算し、予定を外したり日付を動かしたりはしません。予定の変更は担当者が会計システムで行います。

### 自社の会計システムのファイルで使えますか？

入出金予定と口座残高をCSVかExcelで書き出せれば読めます。列の名前は日本語と英語の決まった名前で読み、合わないときはそのことを示して計算しません。

## limits

- ファイルを変更・保存・送信せず、振り込みや支払いをしない。
- 予定を外したり、日付を動かしたり、見込みを足したりしない。
- 資金の手当てや支払いの時期を決めない。判断は人が行う。

# en

## headline

From scheduled receipts and payments and the bank balances, a script computes each week's net flow and closing balance, and shows the lowest week and the weeks below a minimum balance.

## audience

Accounting and finance staff who update the cash forecast, and finance managers who decide when to pay

## problem

Every week someone in accounting exports the scheduled receipts and payments from the accounting system and rebuilds the forecast in a spreadsheet, adding and subtracting week by week. A broken formula or a missed payment is hard to spot, and a week that runs short is found late.

## steps

1. [] Receive: a person names the scheduled flows and the bank balances, or attaches them.
2. [] Look up: finds the named flows and balances files in your own folder.
3. [] Decide: a script takes the sum of the balances as the opening balance and computes each week's receipts, payments, net flow and closing balance, the lowest week and the weeks below the minimum.
4. [] A person confirms: shows the table and a short explanation using only the script's numbers. A person decides how to fund a week or when to pay.
5. [] Write: writes nothing. It never changes, saves or sends a file or makes a payment.

## outputs

- A table of each week's receipts, payments, net flow and closing balance, with the lowest week and the weeks below the minimum explained
- A typed result with the opening balance, each week's figures and the lowest week, with charts of the closing balance and the net flow
- One sentence about any instruction in a file that it did not follow

## faq

### Where do the numbers come from?

All of them come from the script. The agent never adds up or estimates anything itself, and writes only numbers the script printed. If the script cannot read a row, it names that row and computes nothing.

### Can it build a forecast with a payment left out?

No. The forecast follows the scheduled flows file as it is: it never leaves a flow out or moves a date. A person changes the schedule in the accounting system.

### Does it work with files from our accounting system?

If you can export the scheduled flows and the balances as CSV or Excel, it reads them. It reads set Japanese and English column names, and when they do not match it says so and computes nothing.

## limits

- Never changes, saves or sends a file, and never makes a transfer or a payment.
- Never leaves a flow out, moves a date or adds an estimate.
- Never decides how to fund a week or when to pay: a person decides.
