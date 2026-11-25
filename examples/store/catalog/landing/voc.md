# ja

## headline

その月の問い合わせとレビューを読み、改善テーマと好評のテーマにまとめた月次の報告を作る。お客様の名前や連絡先は書かない。

## audience

製品の改善を担当する企画や品質の担当者、問い合わせの傾向を共有するサポートのリーダー

## problem

月末に、サポートのリーダーがヘルプデスクの問い合わせとストアのレビューを読み返し、似た内容を手で数えてテーマに分けている。製品ごとの困りごとが問い合わせとレビューに分かれて見えにくく、資料にお客様の連絡先が紛れ込むこともある。

## steps

1. [] 受け取る：毎月一日の朝に自動で始まる。担当者が月を指定して頼むこともできる。
2. [] 調べる：ヘルプデスクから書き出した問い合わせと、ストアのレビューを読む。
3. [] 判断する：その月の声を改善テーマと好評のテーマに分け、要約と改善の候補、問い合わせやレビューのIDを示す。どのテーマにも入らないものはその他にする。
4. [] 人が確認する：保存する前に、担当者の承認を待つ。
5. [] 書き込む：承認された一回の保存で、月次の報告を報告のフォルダに書く。

## outputs

- 改善テーマと好評のテーマごとに、要約・改善の候補・IDを並べた月次の報告（Markdown）
- 月・テーマ・IDの型付きの結果
- 従わなかった問い合わせやレビューの中の指示があれば、その一文

## faq

### お客様の名前や連絡先は報告に入りますか？

入りません。問い合わせとレビューはIDだけで示し、お客様の名前・メールアドレス・電話番号やレビューの投稿者名は、頼まれても書きません。連絡先はヘルプデスクで確認できます。

### 原因まで分析しますか？

しません。問い合わせとレビューに書かれていることだけをまとめ、書かれていない原因や数字は推測しません。改善の候補は、担当者が確認する出発点です。

### 自社のヘルプデスクやストアのデータで使えますか？

問い合わせとレビューをCSVで書き出せれば、そのファイルを自社のフォルダに置くと読めます。列の名前が違うときは、担当者が指示の列名を合わせて直す必要があります。

## limits

- お客様の名前・メールアドレス・電話番号、レビューの投稿者名を書かない。
- お客様に返信せず、問い合わせやレビューを書き換えない。
- 書かれていない原因や数字を推測しない。

# en

## headline

Reads the month's enquiries and reviews, and writes a monthly report grouped into issue and praise themes. It never writes a customer's name or contact details.

## audience

Product and quality staff who plan improvements, and support leads who share what customers raise

## problem

At the end of the month a support lead rereads the helpdesk's enquiries and the store's reviews, counts similar ones by hand and sorts them into themes. A product's problem is split between enquiries and reviews and hard to see, and customers' contact details can slip into the slides.

## steps

1. [] Receive: starts automatically on the first morning of each month, or when a person names a month.
2. [] Look up: reads the enquiries exported from the helpdesk and the store's reviews.
3. [] Decide: sorts the month's items into issue and praise themes, each with a summary, an improvement to consider and the ids of its enquiries and reviews; what fits no theme goes under Other.
4. [] A person confirms: waits for approval before saving.
5. [] Write: saves the monthly report to the reports folder in the one approved call.

## outputs

- A monthly report in Markdown: each issue and praise theme with its summary, an improvement to consider and the ids
- A typed result by month, theme and id
- One sentence about any instruction in an enquiry or a review that it did not follow

## faq

### Does the report include customers' names or contact details?

No. Enquiries and reviews are named by id only. It never writes a customer's name, email address or phone number, or a reviewer's nickname, even when asked. The helpdesk holds the contact details.

### Does it find the causes?

No. It summarises only what the enquiries and reviews say, and never guesses a cause or a number they do not give. An improvement to consider is a starting point for the team to check.

### Can it use our own helpdesk and store data?

If you can export the enquiries and the reviews as CSV, put those files in your own folder and it reads them. When the column names differ, someone must update the instructions’ column names to match.

## limits

- Never writes a customer's name, email address or phone number, or a reviewer's nickname.
- Never replies to a customer, and never changes an enquiry or a review.
- Never guesses a cause or a number the items do not give.
