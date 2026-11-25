# ja

## headline

退職する人の名前を伝えると、返却物と引き継ぎを一覧にし、権限の取り消しを一件ずつ承認のあとに権限管理に登録する。

## audience

退職の手続きを進める人事部の担当者、アクセス権限を管理する情報システム部の担当者、退職する人の上長

## problem

社員が退職するときは、貸与品の返却、業務の引き継ぎ、システムの権限の取り消しを、それぞれ別の台帳を見ながら進めている。権限の取り消しが一つ漏れると、退職後もシステムに入れる状態が残ってしまう。

## steps

1. [] 受け取る：チャットで、退職する人の名前か社員番号を受け取る。
2. [] 調べる：退職手続きのチェックリスト、人事データ、貸与品の台帳、いまの権限を照らし合わせる。
3. [] 判断する：返却物、引き継ぎ先と上長、権限ごとの取り消しを、根拠の項目をそろえた案にする。
4. [] 人が確認する：権限の取り消しを登録する前に、一件ごとに人の承認を待つ。
5. [] 書き込む：承認された取り消しだけを、権限管理に登録する。

## outputs

- 貸与品と資産番号、引き継ぎ先と上長、権限ごとの取り消しと期限を並べた案
- 案だけを求めたときの、型の決まった案（社員番号、氏名、最終出社日、返却物、引き継ぎ、権限の取り消し）
- 承認のあと権限管理に登録される、一件ずつの権限の取り消し

## faq

### アカウントやメールのデータも消しますか？

消しません。アカウントの削除やデータの消去は、保存期間のあとに情報システム部が人の判断で行います。このエージェントが登録するのは、権限の取り消しだけです。

### 退職の理由や本人の評価を記録できますか？

できません。退職の理由、本人の評価、再雇用の可否は、答えにも登録にも書きません。

### 自社のチェックリストを使えますか？

チェックリスト、人事データ、貸与品の台帳、いまの権限の一覧は、自社のフォルダに置くファイルです。差し替えると、その内容で案を作ります。

## limits

- アカウントの削除やメール・ファイルのデータの消去はしない。
- 退職する人を評価せず、退職の理由も書かない。
- 承認のない取り消しを登録せず、一回の承認で登録するのは一件だけ。
- 退職金の計算など、退職手続き以外の作業はしない。

# en

## headline

Name a leaver: it lists the returns and the handover, and records each access removal in access management after a person approves it.

## audience

HR staff who run offboarding, IT staff who manage access, and the leaver's manager

## problem

When an employee leaves, returning lent items, handing over work and removing system access are each worked through from a different register. Miss one access removal and the person can still sign in after they have left.

## steps

1. [] Receive: takes, in chat, the leaver's name or employee ID.
2. [] Look up: checks the offboarding checklist, the HR records, the register of lent items and the current access.
3. [] Decide: proposes the returns, the person taking over and the manager, and one removal per access, each with its checklist item.
4. [] A person confirms: waits for a person's approval before each access removal is recorded.
5. [] Write: records only the approved removals in access management.

## outputs

- A proposal listing the lent items with their asset numbers, the person taking over and the manager, and each access removal with its end date
- When only a proposal is asked for, a typed proposal (employee ID, name, last working day, returns, handover and removals)
- Access removals recorded one at a time in access management after approval

## faq

### Does it delete the account or the mail data too?

No. IT deletes accounts and erases data by a person's decision once the retention period has passed. This agent records access removals only.

### Can it record the reason for leaving or an assessment of the person?

No. The reason for leaving, any assessment and whether the person may be rehired are written nowhere, in the answer or in a record.

### Can it use our own checklist?

The checklist, the HR records, the register of lent items and the list of current access are files in your own folder. Replace them and it builds the proposal from what they say.

## limits

- Never deletes an account or erases mail or file data.
- Never assesses the leaver or writes the reason for leaving.
- Records no removal without approval, and one approval records one removal only.
- Does no work other than offboarding, such as calculating severance pay.
