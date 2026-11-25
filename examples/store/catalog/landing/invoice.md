# ja

## headline

届いた請求書を発注書と納品書に明細ごとに突き合わせ、差がある明細を判定と処置つきで示す。

## audience

購買部・経理部で請求書を受け付ける担当者

## problem

仕入先から届いた請求書は、担当者が発注書と納品書を並べて、品目、単価、数量が合っているかを明細ごとに確かめている。請求書が月末に集まると、突き合わせが支払いの締めの直前に集中しやすい。

## steps

1. [] 受け取る：仕入先から届いた請求書のファイルを受け取る。
2. [] 調べる：請求書の発注番号から、発注書と納品書の記録を探す。
3. [] 判断する：明細ごとに品目・単価・数量を照合し、「OK・要注意・NG」の判定と処置を付ける。
4. [] 人が確認する：照合結果を保存する前に、担当者の承認を待つ。
5. [] 書き込む：承認された照合結果だけを、照合結果用のフォルダに保存する。

## outputs

- 請求書の明細ごとに、請求・発注・検収の数量と単価、判定、理由、照合ルールにもとづく処置を並べた照合表
- 承認のあと照合結果用のフォルダに保存される、Markdown形式の照合レポート

## faq

### 支払いや仕訳もしますか？

しません。照合して差を示すまでで、支払うかどうかは担当者が決めます。会計・税務の助言もしません。

### 金額や消費税の計算も確かめますか？

確かめません。品目・単価・数量・参照番号を照合し、小計・消費税・合計は担当者や会計システムが確かめます。

### 自社の照合ルールを使えますか？

照合ルールは、自社のフォルダに置くファイルです。差し替えると、その内容で照合します。

## limits

- 請求書を承認したり、支払ったりしない。
- 仕入先に連絡しない。
- 会計・税務の助言をしない。
- 金額を計算し直さない。

# en

## headline

Matches each line of an incoming invoice with its purchase order and delivery note, and flags the lines that differ with a verdict and an action.

## audience

Purchasing and accounts payable staff who receive supplier invoices

## problem

When a supplier invoice arrives, someone lays it beside the purchase order and the delivery note and checks the item, unit price and quantity of every line. When invoices gather at month end, the matching piles up right before the payment run.

## steps

1. [] Receive: takes the invoice file the supplier sent.
2. [] Look up: finds the purchase order and delivery note records from the invoice's order number.
3. [] Decide: matches the item, unit price and quantity of each line, and marks it OK, caution or NG with an action.
4. [] A person confirms: waits for approval before saving the matching result.
5. [] Write: saves only the approved result to the invoice-reports folder.

## outputs

- A matching table, one row per invoice line: invoiced, ordered and accepted quantities and prices, the verdict, the reason and the action from your matching rules
- A matching report in Markdown, saved to the invoice-reports folder once it is approved

## faq

### Does it pay the invoice or book the entry?

No. It matches and shows the differences; a person decides whether to pay. It gives no accounting or tax advice.

### Does it check the amounts and the tax?

No. It matches items, unit prices, quantities and reference numbers; a person or the accounting system checks the subtotal, tax and total.

### Can it use our own matching rules?

The matching rules are files in your own folder. Replace them and it matches against what they say.

## limits

- Never approves or pays an invoice.
- Never contacts the supplier.
- Gives no accounting or tax advice.
- Never recomputes an amount.
