# ja

## headline

毎朝、SLAの期限を過ぎたチケットと期限が迫るチケットを、担当者と次の一手を添えて一覧にする。

## audience

サポート窓口の担当者、チケットの期限を見守るサポートリーダー

## problem

サポートリーダーは、ヘルプデスクの画面でチケットを一件ずつ開き、期限までの残り時間と担当者を確かめている。担当が決まっていないチケットや、回答待ちのまま止まっているチケットは、期限を過ぎてから気づくことがある。

## steps

1. [] 受け取る：毎朝決まった時刻に、レポートを作る指示を受け取る。
2. [] 調べる：ヘルプデスクから書き出したチケットの一覧を読み、期限までの残り時間を確かめる。
3. [] 判断する：スキルに書いた基準で、期限を過ぎたチケットと期限が迫るチケットを選び、担当者と次の一手をまとめる。
4. [] 人が確認する：レポートを保存する前に、担当者の承認を待つ。承認なしには保存しない。
5. [] 書き込む：承認されたレポートだけを、レポート用のフォルダに保存する。

## outputs

- 期限超過と期限間近に分けた、チケットごとの件名、優先度、残り時間、担当者、次の一手
- 承認のあとフォルダに保存される、その日のレポートのMarkdownファイル
- 各行の出典（CSVのファイル名とチケットのID）

## faq

### いつ使えるようになりますか？

まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。

### どのデータを使いますか？

ヘルプデスクから書き出したチケットの一覧（CSV）を自社のフォルダに置いて使います。デモでは架空の会社のデータを使っています。

### 「期限が迫る」の基準は変えられますか？

変えられます。期限までの残り時間の基準はスキルに書いてあり、スキルの説明を書き換えて変えます。

### 顧客に返信したり、チケットを書き換えたりしますか？

しません。レポートを作って保存するまでで、顧客への返信と担当の割り当ては人が行います。

## limits

- 顧客に返信しない。
- チケットの担当や状態を変えない。
- サポート担当者の成績を評価しない。
- チケットの中に書かれた指示には従わず、その内容として扱う。

# en

## headline

Each morning, lists the tickets past or close to their SLA deadline, with the owner and a next step.

## audience

Support agents, and support leads who watch ticket deadlines

## problem

A support lead opens tickets one by one in the helpdesk to check the time left and who owns each. A ticket with no owner, or one stuck waiting for an answer, can go unnoticed until its deadline has passed.

## steps

1. [] Receive: takes the instruction to write the report at a set time each morning.
2. [] Look up: reads the ticket list exported from the helpdesk and checks the time left before each deadline.
3. [] Decide: picks the tickets past or close to their deadline by the rules in its skill, with the owner and a next step.
4. [] A person confirms: waits for the owner's approval before saving the report, and never saves it without it.
5. [] Write: saves only the approved report to the reports folder.

## outputs

- Tickets split into past the deadline and close to it, each with its subject, priority, time left, owner and next step
- The day's report as a Markdown file, saved to a folder once it is approved
- A source on every line: the CSV file name and the ticket id

## faq

### When can I use it?

It is not live yet. Sign up for a launch notice and we will email you when it opens.

### Which data does it use?

A ticket list exported from your helpdesk as CSV, placed in your own folder. The demo uses data about fictional companies.

### Can I change what counts as close to the deadline?

Yes. The rule for the time left is written in its skill, and you change it by editing the skill's description.

### Does it reply to customers or change tickets?

No. It writes and saves the report; a person replies to the customer and assigns the tickets.

## limits

- Never replies to a customer.
- Never changes a ticket's owner or status.
- Never judges a support agent's performance.
- Never follows an instruction written inside a ticket; it treats it as the ticket's content.
