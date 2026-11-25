# ja

## headline

届いた請求書と入力した仕訳を自社の経理ルールに照らし、登録番号・税率の記載・税区分コードなどをルールごとに判定する。税務の助言はしない。

## audience

請求書を受け付けて仕訳を入力する経理部の担当者、その確認をする経理責任者

## problem

請求書が届くと、担当者が登録番号の有無、税率ごとの記載、宛名や日付を目で確かめ、入力した仕訳の税区分コードが社内の表どおりかを見比べている。月末に請求書が集まると確認が追いつかず、コードの入力違いや合計の打ち間違いが計上の後で見つかることがある。

## steps

1. [] 受け取る：取引先から届いた請求書のファイルを受け取る。
2. [] 調べる：請求書番号から仕訳入力データを、自社の経理ルールの各項目を探して読む。
3. [] 判断する：ルールごとに、請求書と仕訳の記載を引用し、「OK・要注意・NG」の判定と処置を付ける。税務の助言はしない。
4. [] 人が確認する：チェック結果を保存する前に、担当者の承認を待つ。
5. [] 書き込む：承認されたチェック結果だけを、結果用のフォルダに保存する。

## outputs

- 経理ルールごとに、請求書と仕訳の記載、判定、理由、ルールにもとづく処置を並べたチェック表
- 承認のあと結果用のフォルダに保存される、Markdown形式のチェック結果

## faq

### 消費税の取扱いや、控除できるかを教えてくれますか？

教えません。自社の経理ルールに書かれた点を確かめるだけで、税法や控除の可否、申告については答えません。判断は経理部や顧問の税理士が行います。

### 税額や合計を計算し直しますか？

しません。請求書と仕訳入力データに書かれた数字をそのまま比べます。

### 計上や支払いもしますか？

しません。チェック結果を示すまでで、計上してよいかは経理部が決めます。取引先にも連絡しません。

### 自社の経理ルールや税区分コードの表を使えますか？

ルールと税区分コードの表は自社のフォルダに置くファイルです。差し替えると、その内容で判定します。

## limits

- 税務の助言をしない。税法や控除の可否、申告について答えない。
- 計上・承認・支払いをしたり、取引先に連絡したりしない。
- 自社の経理ルールにない基準で判定しない。
- 税額や合計を計算し直さない。

# en

## headline

Checks a supplier invoice and the entry typed for it against your own accounting rules, judging the registration number, tax rates and tax codes rule by rule. It gives no tax advice.

## audience

Accounting staff who receive invoices and type the entries, and the accounting lead who reviews them

## problem

When an invoice arrives, someone checks by eye that it shows the registration number, the amounts per tax rate, the addressee and the date, and compares the tax codes typed into the entry with the company's table. At month end the checks fall behind, and a wrong code or a mistyped total is found only after the entry is booked.

## steps

1. [] Receive: takes the supplier's invoice file.
2. [] Look up: finds and reads the entry of the invoice number and the rules in your accounting manual.
3. [] Decide: for each rule, quotes the invoice and the entry, and marks it OK, caution or NG with an action. It gives no tax advice.
4. [] A person confirms: waits for approval before saving the check.
5. [] Write: saves only the approved check to the results folder.

## outputs

- A check table, one row per accounting rule: what the invoice and the entry say, the verdict, the reason and the action from your rules
- The check in Markdown, saved to the results folder once it is approved

## faq

### Does it tell us how the tax is treated, or whether it can be deducted?

No. It checks only what your own accounting rules state; it does not answer questions on tax law, deductions or returns. Your accounting team or tax adviser decides.

### Does it recompute the tax or the totals?

No. It compares the figures printed on the invoice and in the entry as they are.

### Does it book or pay the invoice?

No. It shows the check; the accounting team decides whether the entry is booked. It never contacts the supplier.

### Can it use our own rules and tax code table?

The rules and the tax code table are files in your own folder. Replace them and it judges against what they say.

## limits

- Gives no tax advice; never answers on tax law, deductions or returns.
- Never books, approves or pays, and never contacts the supplier.
- Never judges by a standard that is not in your own accounting rules.
- Never recomputes a tax amount or a total.
