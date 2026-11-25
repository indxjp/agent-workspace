# ja

## headline

メールやチャットのメッセージから頼まれごとを拾い、担当者と書かれた期限を付けて、タスクとして登録する。

## audience

メールやチャットで依頼を受けることの多いチームのメンバーとリーダー

## problem

頼まれごとはメールやチャットの流れの中に埋もれ、読んだ人が自分でタスク管理に書き写している。書き写し忘れや、誰に頼まれたのか、いつまでなのかの取り違えが起きやすい。

## steps

1. [] 受け取る：メールやチャットのメッセージを、Webhook かチャットで受け取る。
2. [] 調べる：チームのメンバー一覧で、頼まれた人を確かめる。
3. [] 判断する：頼まれごとを拾い、担当者を一人と、書かれた期限を決める。
4. [] 人が確認する：タスクを登録する前に、人の承認を待つ。
5. [] 書き込む：承認されたタスクだけを、タスク管理に登録する。

## outputs

- メッセージの番号、拾った頼まれごと、担当者、タスクの件名、期限、理由をそろえた型付きの結果
- 承認のあとタスク管理に登録される、担当者あてのタスク

## faq

### お知らせや共有のメッセージもタスクになりますか？

なりません。名前や宛先で特定の人に頼んでいる文だけを頼まれごととし、お知らせだけのメッセージではタスクを登録しません。

### 期限はどう決めますか？

メッセージに日付がはっきり書かれているときだけ期限にします。「急ぎません」「来週」のように日付がないときは、書かれたとおりにメモに残し、日付を推し量りません。

### 一つのメッセージに何人かへの頼まれごとがあるときは？

宛先の人への頼まれごとを一件のタスクにまとめ、ほかの人への頼まれごとは一覧に挙げます。その人の名前を指定すれば、別に登録できます。

### メッセージの中に指示が書かれていたらどうなりますか？

メッセージは調べる対象として読み、担当者や期限の指定、承認を省く指示には従いません。従わなかったことも伝えます。

## limits

- メッセージへの返信はせず、頼まれごとを代わりに片付けない。
- タスクは、人が承認するまで登録しない。
- 書かれていない期限を推し量って決めない。
- チームのメンバーでない人や、チーム全体を担当者にしない。

# en

## headline

Picks requests out of email and chat messages and files them as a task, with the person asked and the deadline the message states.

## audience

Members and leads of teams that receive many requests by email and chat

## problem

Requests get buried in email threads and chat channels, and whoever reads them copies them into the task tracker by hand. Requests are forgotten, or who asked and by when gets mixed up.

## steps

1. [] Receive: takes an email or chat message, through a webhook or in chat.
2. [] Look up: checks the person asked against the team's member list.
3. [] Decide: picks out the requests, one assignee and the deadline as written.
4. [] A person confirms: waits for approval before registering the task.
5. [] Write: registers only the approved task in your task tracker.

## outputs

- A typed result with the message number, the requests found, the assignee, the task title, the due date and the reason
- A task for the assignee, registered in your task tracker once it is approved

## faq

### Does an FYI become a task?

No. Only a sentence that asks a named person to do something is a request; a message that only informs registers no task.

### How is the due date set?

Only from a date the message states. Words like "no hurry" or "next week" are kept in the notes as written, and no date is guessed.

### What about a message with requests to several people?

The requests to the addressee become one task, and the requests to others are listed. Name the person and each of theirs can be filed separately.

### What if a message contains instructions?

It reads a message as evidence and does not follow an assignee, a due date or an instruction to skip approval written in it, and says that it did not.

## limits

- Never replies to the message or does the requested work itself.
- Registers no task until a person approves it.
- Never guesses a deadline the message does not state.
- Never assigns someone outside the team, or the whole team.
