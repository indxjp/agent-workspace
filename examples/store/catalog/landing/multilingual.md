# ja

## headline

海外のお客様からの問い合わせに日本語の要約を付け、FAQ に沿った返信の下書きをお客様の言語で作って、担当者に渡す。

## audience

海外のお客様に対応するサポート窓口の担当者、越境販売の担当者

## problem

英語や中国語、韓国語などで問い合わせが届くと、読める人を探すか翻訳の道具に貼り付けて内容をつかみ、返信も同じ手間をかけて書いている。誰が何を答えるかが決まるまでに時間がかかり、FAQ にない約束を書いてしまうおそれもある。

## steps

1. [] 受け取る：海外のお客様からの問い合わせを、Webhook かチャットで受け取る。
2. [] 調べる：FAQ と、分類ごとの担当者の一覧を照らし合わせる。
3. [] 判断する：言語と分類を見分け、要約と、お客様の言語での返信の下書きを書き、担当者を一人選ぶ。
4. [] 人が確認する：担当者へのタスクを登録する前に、人の承認を待つ。
5. [] 書き込む：承認されたタスクだけを、要約と下書きを付けてタスク管理に登録する。

## outputs

- 問い合わせの番号、言語、分類、要約、担当者、返信の下書き、使った FAQ をそろえた型付きの結果
- 承認のあとタスク管理に登録される、要約と返信の下書きを付けた担当者あてのタスク

## faq

### 返信はお客様に送られますか？

送りません。返信は下書きとして担当者に渡し、確かめて送るのは担当者です。

### FAQ にないことを返信に書きませんか？

返信には FAQ に書かれていることだけを書きます。到着日や確定した返金、値引きのように FAQ にない約束はせず、担当者が確認してから連絡すると書きます。

### どの言語に対応していますか？

問い合わせの言語を見分けて、その言語で返信の下書きを作ります。サンプルには英語、中国語、韓国語、スペイン語の問い合わせが入っています。

### 問い合わせの中に指示が書かれていたらどうなりますか？

問い合わせは調べる対象として読み、そこに書かれた指示には従いません。従わなかったことを要約に書きます。

## limits

- 返信は下書きにとどめ、お客様には送らない。
- FAQ にない約束（到着日、返金、値引き）は書かない。
- 担当者へのタスクは、人が承認するまで登録しない。
- 訳の正しさは、送る前に担当者が確かめる。

# en

## headline

Adds a summary to each enquiry from a customer abroad, drafts a reply that follows your FAQ in the customer's language, and hands both to the owner.

## audience

Support agents who serve customers abroad, and teams that sell across borders

## problem

When an enquiry arrives in English, Chinese, Korean or another language, someone who can read it has to be found, or it is pasted into a translation tool, and the reply takes the same effort. It takes time to decide who answers what, and a reply can promise something the FAQ does not.

## steps

1. [] Receive: takes an enquiry from a customer abroad, through a webhook or in chat.
2. [] Look up: checks the FAQ and the list of owners by category.
3. [] Decide: tells the language and the category, writes a summary and a reply draft in the customer's language, and picks one owner.
4. [] A person confirms: waits for approval before registering the task for the owner.
5. [] Write: registers only the approved task, with the summary and the draft, in your task tracker.

## outputs

- A typed result with the enquiry number, language, category, summary, owner, reply draft and the FAQ used
- A task for the owner with the summary and the reply draft, registered in your task tracker once it is approved

## faq

### Is the reply sent to the customer?

No. The reply is a draft handed to the owner, who checks it and sends it.

### Will the reply say things the FAQ does not?

The reply says only what the FAQ says. It promises nothing the FAQ does not, such as an arrival date, a confirmed refund or a discount, and says the person in charge will confirm and reply.

### Which languages does it handle?

It tells the language of the enquiry and drafts the reply in that language. The sample has enquiries in English, Chinese, Korean and Spanish.

### What if an enquiry contains instructions?

It reads an enquiry as evidence and does not follow instructions written in it, and says so in the summary.

## limits

- Keeps the reply a draft and sends nothing to the customer.
- Promises nothing the FAQ does not: no arrival date, refund or discount.
- Registers no task until a person approves it.
- The owner checks the translation before anything is sent.
