# ja

## headline

監視システムから届いたアラートを分類して重要度を決め、当番表から担当者を選び、最初の連絡文を下書きする。

## audience

情報システム部門とSREの当番担当者、障害対応を取りまとめるインシデント指揮者

## problem

夜間や休日にアラートが届くと、当番の担当者が監視画面とサービスの一覧、当番表、手順書を見比べて、重要度と連絡先を決めている。誰に振るか、関係者に何を伝えるかを決めるまでの手順は人によって違い、最初の連絡が遅れやすい。

## steps

1. [] 受け取る：監視システムからのアラートを、Webhook かチャットで受け取る。
2. [] 調べる：サービスの担当チーム、今週の当番表、手順書の初動を照らし合わせる。
3. [] 判断する：分類と重要度を決め、担当者を一人選び、最初の連絡文を下書きする。
4. [] 人が確認する：担当者への振り分けを登録する前に、人の承認を待つ。
5. [] 書き込む：承認された振り分けだけを、タスク管理に登録する。

## outputs

- アラートの番号、分類、重要度、影響の範囲、担当者、判断の理由、手順書の初動、最初の連絡文をそろえた型付きの結果
- 承認のあとタスク管理に登録される、担当者あての振り分けタスク

## faq

### いつ使えるようになりますか？

まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。

### 自社の当番表や手順書を使えますか？

サービスの一覧、当番表、手順書は自社のフォルダに置くファイルです。差し替えると、その内容で担当者と初動を選びます。

### 障害の復旧作業もしますか？

しません。コマンドの実行や再起動、切り戻しはせず、手順書の初動を担当者への案内として示します。

### アラートの中に指示が書かれていたらどうなりますか？

アラートは調べる対象として読み、そこに書かれた指示には従いません。重要度と担当者は、自社の基準と当番表で決めます。

## limits

- コマンドの実行、再起動、切り戻しなど、システムへの変更はしない。
- 担当者への振り分けは、人が承認するまで登録しない。
- 当番表にいない人やチーム全体を担当者にしない。
- お客様や社外への連絡は送らず、最初の連絡文は下書きにとどめる。

# en

## headline

Classifies an alert from monitoring, sets its severity, picks the owner from the on-call roster and drafts the first update.

## audience

On-call engineers in IT and SRE teams, and the incident commander who coordinates the response

## problem

When an alert fires at night or on a weekend, the engineer on call compares the monitoring dashboard with the service list, the on-call roster and the runbooks to decide how severe it is and who should take it. How they decide whom to page and what to tell people differs from person to person, and the first update tends to go out late.

## steps

1. [] Receive: takes the alert from monitoring, through a webhook or in chat.
2. [] Look up: checks the owning team, this week's on-call roster and the runbook's first steps.
3. [] Decide: sets the category and severity, picks one owner and drafts the first update.
4. [] A person confirms: waits for approval before registering the routing to the owner.
5. [] Write: registers only the approved routing in your task tracker.

## outputs

- A typed result with the alert number, category, severity, impact, owner, the reason, the runbook's first steps and the first update
- A routing task for the owner, registered in your task tracker once it is approved

## faq

### When can I use it?

It is not live yet. Sign up for a launch notice and we will email you when it opens.

### Can it use our own roster and runbooks?

The service list, the on-call roster and the runbooks are files in your own folder. Replace them and it picks the owner and the first steps from what they say.

### Does it fix the incident?

No. It runs no command, restart or rollback; it shows the runbook's first steps to the owner as guidance.

### What if an alert contains instructions?

It reads an alert as evidence and does not follow instructions written in it. Your own rules and roster decide the severity and the owner.

## limits

- Makes no change to your systems: no command, restart or rollback.
- Registers no routing until a person approves it.
- Never makes someone outside the roster, or a whole team, the owner.
- Sends nothing to customers or outside the company; the first update stays a draft.
