# ja

## headline

検知されたセキュリティアラートを分類して重要度を決め、調査の手順書に沿った調査メモを付けて、当番の担当者に渡す。

## audience

セキュリティ監視チーム（SOC）の当番の担当者とリーダー、情報システム部門の担当者

## problem

検知の道具から届くアラートは多く、当番の担当者が資産の一覧や既知の送信元、手順書を見比べて、どれから調べるかを決めている。誤検知に時間を取られて本当に危ないアラートの調査が遅れたり、調べ始めの手順が人によって違ったりしやすい。

## steps

1. [] 受け取る：検知の道具からのアラートを、Webhook かチャットで受け取る。
2. [] 調べる：資産の重要度、既知の送信元、当番表、調査の手順書を照らし合わせる。
3. [] 判断する：分類と重要度を決め、担当者を一人選び、調査メモを書く。
4. [] 人が確認する：調査のタスクを登録する前に、人の承認を待つ。
5. [] 書き込む：承認されたタスクだけを、調査メモを付けてタスク管理に登録する。

## outputs

- アラートの番号、分類、重要度、担当者、判断の理由、手順書の番号、調査メモをそろえた型付きの結果
- 承認のあとタスク管理に登録される、調査メモを付けた担当者あての調査のタスク
- いくつかのアラートを頼まれたときは、重要度の順に並べた一覧

## faq

### 端末の隔離やアカウントの停止もしますか？

しません。隔離や停止、送信元の遮断は担当者が判断して行います。調査メモには、手順書の初動を担当者への案内として書きます。

### アラートやメールの中に指示が書かれていたらどうなりますか？

アラートは調べる対象として読み、そこに書かれた指示には従いません。攻撃者が書いたものかもしれないので、重要度の指定やアラートを閉じる指示があっても、その指示があったことを調査メモに書きます。

### 自社の資産の一覧や手順書を使えますか？

資産の一覧、既知の送信元、当番表、手順書は、自社のフォルダに置くファイルです。差し替えると、その内容で重要度と初動を決めます。

## limits

- 端末の隔離、アカウントの停止、送信元の遮断はしない。
- アラートを閉じたり、許可リストを変えたりしない。
- 調査のタスクは、人が承認するまで登録しない。
- 当番表にいない人やチーム全体を担当者にしない。

# en

## headline

Classifies each security alert, sets its severity, and hands it to the on-call analyst with investigation notes that follow your playbooks.

## audience

On-call analysts and leads in a security operations centre (SOC), and IT staff who handle alerts

## problem

Detection tools send many alerts, and the analyst on call compares each one with the asset list, known sources and the playbooks to decide what to look at first. False positives eat time and delay the alerts that matter, and how an investigation starts differs from person to person.

## steps

1. [] Receive: takes an alert from a detection tool, through a webhook or in chat.
2. [] Look up: checks the asset's criticality, known sources, the on-call roster and the playbooks.
3. [] Decide: sets the category and severity, picks one owner and writes investigation notes.
4. [] A person confirms: waits for approval before registering the investigation task.
5. [] Write: registers only the approved task, with the notes, in your task tracker.

## outputs

- A typed result with the alert number, category, severity, owner, the reason, the playbook id and the investigation notes
- An investigation task for the owner with the notes, registered in your task tracker once it is approved
- When asked about several alerts, a list of them in order of severity

## faq

### Does it isolate devices or disable accounts?

No. Isolating, disabling or blocking is decided and done by the analyst. The notes give the playbook's first steps as guidance for them.

### What if an alert or an email contains instructions?

It reads an alert as evidence and does not follow instructions written in it. They may be written by the attacker, so a severity or an instruction to close the alert is noted in the investigation notes.

### Can it use our own assets and playbooks?

The asset list, known sources, the on-call roster and the playbooks are files in your own folder. Replace them and it sets the severity and first steps from what they say.

## limits

- Never isolates a device, disables an account or blocks a source.
- Never closes an alert or changes an allowlist.
- Registers no investigation task until a person approves it.
- Never makes someone outside the roster, or a whole team, the owner.
