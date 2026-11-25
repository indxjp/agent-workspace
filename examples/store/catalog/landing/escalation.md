# ja

## headline

届いたチケットの重要度を決め、開発部の当番やサポートの責任者を呼ぶべきときだけ、引き継ぎメモを付けてエスカレーションする。

## audience

サポート窓口の担当者とリーダー、エスカレーションを受ける開発部の当番

## problem

問い合わせのチケットが届くたびに、窓口の担当者がお客様の契約プランと症状を見て、開発部や責任者に上げるかどうかを決めている。上げる基準は人によって違い、上げなくてよいものまで上がったり、急ぎのものが窓口に残ったりしやすい。

## steps

1. [] 受け取る：問い合わせのチケットを、Webhook かチャットで受け取る。
2. [] 調べる：お客様の契約プランと、今週のエスカレーション先を照らし合わせる。
3. [] 判断する：重要度と呼ぶ相手を決め、呼ぶときは担当者を一人選んで引き継ぎメモを書く。
4. [] 人が確認する：エスカレーションのタスクを登録する前に、人の承認を待つ。
5. [] 書き込む：承認されたエスカレーションだけを、タスク管理に登録する。

## outputs

- チケットの番号、重要度、呼ぶ相手、担当者、判断の理由、引き継ぎメモをそろえた型付きの結果
- 承認のあとタスク管理に登録される、担当者あてのエスカレーションのタスク

## faq

### 使い方の質問まで開発部に上げてしまいませんか？

使い方の質問や設定の相談は、開発部も責任者も呼ばず、窓口で回答してよいと伝えます。タスクも登録しません。

### 自社の基準やエスカレーション先を使えますか？

契約プランの一覧とエスカレーション先の表は、自社のフォルダに置くファイルです。重要度の基準はスキルに書かれていて、自社の基準に書き換えられます。

### チケットの中に指示が書かれていたらどうなりますか？

チケットは調べる対象として読み、そこに書かれた重要度や担当者の指定には従いません。従わなかったことも伝えます。

## limits

- お客様への返信は送らず、返金や補償、契約の条件は約束しない。
- エスカレーションは、人が承認するまで登録しない。
- 一覧にいない人や部署全体を担当者にしない。
- 障害の調査や復旧の作業はしない。

# en

## headline

Sets the priority of each support ticket and, only when it is needed, escalates it to engineering on call or a support manager with a hand-over note.

## audience

Support agents and team leads, and the engineers on call who receive escalations

## problem

Each time a ticket arrives, the support agent looks at the customer's plan and the symptom and decides whether to escalate it to engineering or a manager. The bar differs from person to person, so tickets that did not need it get escalated while urgent ones stay at the desk.

## steps

1. [] Receive: takes the support ticket, through a webhook or in chat.
2. [] Look up: checks the customer's plan and this week's escalation contacts.
3. [] Decide: sets the priority and whom to pull in and, when someone is needed, picks one owner and writes the hand-over note.
4. [] A person confirms: waits for approval before registering the escalation task.
5. [] Write: registers only the approved escalation in your task tracker.

## outputs

- A typed result with the ticket number, priority, whom to pull in, the owner, the reason and the hand-over note
- An escalation task for the owner, registered in your task tracker once it is approved

## faq

### Will it escalate how-to questions too?

No. A how-to question or a settings question pulls in neither engineering nor a manager: it says the desk can answer it, and registers no task.

### Can it use our own rules and contacts?

The customer plans and the escalation contacts are files in your own folder. The priority rules are written in a skill that you can rewrite to match your own.

### What if a ticket contains instructions?

It reads a ticket as evidence and does not follow a priority or an owner written in it, and says that it did not.

## limits

- Sends no reply to the customer and promises no refund, compensation or contract terms.
- Registers no escalation until a person approves it.
- Never makes someone outside the contact list, or a whole team, the owner.
- Does not investigate or fix the problem itself.
