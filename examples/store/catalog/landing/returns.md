# ja

## headline

返品の申込を返品規程と注文データに照らし、規程の項目ごとに判定と確認点を一覧にする。

## audience

ネットショップのカスタマーサポート担当者、返品の受付を取りまとめる店舗運営の担当者

## problem

返品の申込が届くと、サポートの担当者が注文管理システムで注文を探し、返品規程と見比べながら期限、商品の状態、返品できない商品かどうかを一つずつ確かめている。申込の書き方がまちまちで、確認の漏れが起きやすい。

## steps

1. [] 受け取る：問い合わせフォームから書き出した返品の申込を受け取る。
2. [] 調べる：注文データから同じ注文番号の行を探し、返品規程の項目と照らす。
3. [] 判断する：規程の項目ごとに「OK・要確認・NG」の判定と、担当者が確認する点を付ける。
4. [] 人が確認する：確認表を保存する前に、担当者の承認を待つ。
5. [] 書き込む：承認された確認表だけを、レポート用のフォルダに保存する。

## outputs

- 返品規程の項目ごとに、申込と注文データの記載、判定、理由、確認する点を並べた表
- 承認のあとレポート用のフォルダに保存される、Markdown形式の確認表

## faq

### いつ使えるようになりますか？

まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。

### 返金まで決めますか？

決めません。規程の項目ごとの判定までを示し、返品や返金を受け付けるかどうかは担当者が判断します。

### 自社の返品規程を使えますか？

返品規程と注文データは、自社のフォルダに置くファイルです。差し替えると、その内容で判定します。

### お客様への返信も作りますか？

作りません。お客様とのやり取りは担当者が行います。

## limits

- 返品、交換、返金を決めず、返金額も確定しない。
- お客様にメッセージを送らず、返信の文面も作らない。
- 返品規程にない論点には、判定を付けない。

# en

## headline

Checks a return request against your return policy and the order record, with a verdict and what to confirm for each policy item.

## audience

Customer support staff at an online shop, and the people who run its returns

## problem

When a return request arrives, someone on the support desk finds the order in the order system and checks the deadline, the condition of the item and whether it can be returned at all, one rule at a time against the return policy. Customers write requests in many ways, so a check is easy to miss.

## steps

1. [] Receive: takes a return request exported from the contact form.
2. [] Look up: finds the order's rows in the order records and reads the return policy.
3. [] Decide: marks each policy item OK, caution or NG, with what the support desk should confirm.
4. [] A person confirms: waits for approval before saving the review.
5. [] Write: saves only the approved review to the returns-reports folder.

## outputs

- A table with one row per policy item: what the request and the order record say, the verdict, the reason and what to confirm
- A review in Markdown, saved to the returns-reports folder once it is approved

## faq

### When can I use it?

It is not live yet. Sign up for a launch notice and we will email you when it opens.

### Does it decide the refund?

No. It gives a verdict for each policy item; a person decides whether to accept the return and refund.

### Can it use our own return policy?

The return policy and the order records are files in your own folder. Replace them and it checks against what they say.

### Does it write the reply to the customer?

No. A person handles the exchange with the customer.

## limits

- Never decides a return, an exchange or a refund, or its amount.
- Never sends the customer a message or drafts a reply.
- Gives no verdict on points the return policy does not cover.
