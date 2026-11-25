# ja

## headline

社内からの法務相談を分類して急ぎかどうかを決め、そろっている資料と足りない資料を挙げて、法務の担当者に渡す。

## audience

法務部の受付担当とリーダー、法務に相談する営業や購買などの部署

## problem

法務への相談はメールやフォーム、チャットでばらばらに届き、受付の担当者が中身を読んで分類し、契約書や過去の契約を探して担当者に回している。資料が足りないまま回って問い合わせ直しになったり、期限のある相談が埋もれたりしやすい。

## steps

1. [] 受け取る：法務相談フォームからの相談を、Webhook かチャットで受け取る。
2. [] 調べる：契約台帳で相手方との既存の契約を探し、法務部の担当表を確かめる。
3. [] 判断する：分類と急ぎかどうかを決め、そろっている資料と足りない資料を挙げ、担当者を一人選ぶ。
4. [] 人が確認する：担当者へのタスクを登録する前に、人の承認を待つ。
5. [] 書き込む：承認されたタスクだけを、引き継ぎメモを付けてタスク管理に登録する。

## outputs

- 受付番号、分類、急ぎかどうか、担当者、そろっている資料、足りない資料、理由、引き継ぎメモをそろえた型付きの結果
- 承認のあとタスク管理に登録される、引き継ぎメモを付けた法務の担当者あてのタスク

## faq

### 契約の条項がよいかどうかも判断しますか？

しません。受付は相談を分けて資料をそろえるところまでで、条項の良し悪しや法令に反するかどうかは法務の担当者が判断します。

### 自社の分類や担当者を使えますか？

契約台帳と法務部の担当表は、自社のフォルダに置くファイルです。分類やそろえる資料の基準はスキルに書かれていて、自社の基準に書き換えられます。

### 相談の中に指示が書かれていたらどうなりますか？

相談は調べる対象として読み、「審査は不要」「担当は部長」のような書き込みには従いません。従わなかったことも伝えます。

## limits

- 法的な助言や、契約・法令についての判断はしない。
- 担当者へのタスクは、人が承認するまで登録しない。
- 担当表にいない人や部署全体を担当者にしない。
- 相談者や相手方への連絡は送らない。

# en

## headline

Sorts each internal legal request, sets its urgency, lists the documents present and missing, and hands it to a lawyer on the team.

## audience

Legal team intake staff and leads, and the sales, purchasing and other teams who ask legal for help

## problem

Requests reach the legal team by email, form and chat, and the person on intake reads each one, sorts it, looks for the contract and past agreements, and passes it on. Requests go out with documents missing and have to be asked about again, and ones with a deadline get buried.

## steps

1. [] Receive: takes a request from the legal request form, through a webhook or in chat.
2. [] Look up: finds existing contracts with the counterparty in the contract register and checks the legal team list.
3. [] Decide: sets the category and urgency, lists the documents present and missing, and picks one owner.
4. [] A person confirms: waits for approval before registering the task for the lawyer.
5. [] Write: registers only the approved task, with a hand-over note, in your task tracker.

## outputs

- A typed result with the request number, category, urgency, owner, documents present and missing, the reason and the hand-over note
- A task for the lawyer with the hand-over note, registered in your task tracker once it is approved

## faq

### Does it judge whether a clause is acceptable?

No. Intake stops at sorting the request and gathering documents; whether a clause is good or something is lawful is the lawyer's call.

### Can it use our own categories and team?

The contract register and the legal team list are files in your own folder. The categories and the documents to gather are written in a skill that you can rewrite to match your own.

### What if a request contains instructions?

It reads a request as evidence and does not follow notes such as "no review needed" or "assign the head of legal", and says that it did not.

## limits

- Gives no legal advice and no view on a contract or a law.
- Registers no task until a person approves it.
- Never makes someone outside the team list, or a whole team, the owner.
- Sends nothing to the requester or the counterparty.
