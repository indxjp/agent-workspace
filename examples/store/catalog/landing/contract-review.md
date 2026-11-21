# ja

## headline

相手方の契約書を自社の審査基準と条項ごとに照らし、リスク表と修正案を法務の手元にそろえる。

## audience

法務部の契約審査担当、相手方から契約書を受け取る営業部門の担当者

## problem

相手方から届いた契約書のドラフトを、担当者が自社の審査基準と一条ずつ見比べている。責任の上限、自動更新、知的財産の帰属のように見落としやすい条項の確認は人の注意力に頼り、修正文案も毎回一から書いている。

## steps

1. [person, files] 受け取る：添付された、または契約書フォルダにある Word のドラフトを、依頼した人が閲覧できる範囲だけを読む。
2. [files] 調べる：スキルの検出ルールを各条項に当て、指摘に審査基準ファイルの標準条項を添える。
3. [structured] 判断する：指摘ごとに条項・論点・リスク度・理由・修正文案をそろえたリスク表を作る。
4. [] 人が確認する：修正案を保存する前に実行が止まり、法務担当者の承認を待つ。
5. [] 書き込む：承認された修正案だけを、修正案つきの Word ファイルにする。

## outputs

- 条項・論点・リスク度・理由・修正文案を並べたリスク表（チャットに表で表示）
- 承認された修正案を書き込んだ Word ファイル（.docx）

## faq

### 契約書のデータはどこに置かれますか？

契約書と審査基準は、インストールした環境のフォルダに置かれます。エージェントは頼んだ人に許可されたフォルダだけを読みます。ストアのデモは架空のサンプル契約書だけで動きます。

### 締結してよいかどうかも判断しますか？

しません。リスク表と修正文案は判断材料で、締結の可否は法務担当者が決めます。

### 自社の審査基準に合わせられますか？

論点の名前、重大度、標準条項の文言は、フォルダの中の審査基準ファイルから読みます。何を問題として検出するかはスキルのスクリプトに書かれているので、検出ルールを変えるときはそのスクリプトを直します。

### 検出ルールが拾わない問題はどうなりますか？

検出ルールは最低ラインです。ルールにない問題に気づいたときは表の前に短く書きますが、すべての問題を見つけるとは限りません。

## limits

- 法的助言はせず、締結の可否も書かない。
- 条文に書かれていない事実（相手方の意図や業界の慣行）を理由にしない。
- 法務担当者の承認なしに修正案を保存しない。

# en

## headline

Checks a counterparty's contract clause by clause against your review standards, and puts a risk table and suggested fixes in front of legal.

## audience

Contract reviewers in legal, and sales staff who receive contracts from counterparties

## problem

When a draft contract arrives, someone compares it with the company's review standards one clause at a time. Catching the clauses that are easy to miss, such as the liability cap, automatic renewal and who owns background IP, depends on attention, and the fixes are drafted from scratch each time.

## steps

1. [person, files] Receive: reads the attached Word draft, or one in the contracts folder, only within what the asking person may read.
2. [files] Look up: runs the skill's detection rules over each clause and attaches the standard clause from your review-standard files to each finding.
3. [structured] Decide: builds a risk table with the clause, issue, risk level, reason and suggested wording for each finding.
4. [] A person confirms: the run stops before saving the redline and waits for legal to approve it.
5. [] Write: only the approved redline becomes a Word file with the fixes in it.

## outputs

- A risk table of clause, issue, risk level, reason and suggested wording (shown as a table in the chat)
- A Word file (.docx) with the approved fixes written in

## faq

### Where is the contract data kept?

Contracts and review standards stay in folders of the environment you install it in. The agent reads only the folders the asking person is allowed to read. The store's demo runs on fictional sample contracts only.

### Does it decide whether to sign?

No. The risk table and the suggested wording are material for a decision; legal decides whether to sign.

### Can it follow our own review standards?

The issue titles, severities and standard clause wording come from the review-standard files in a folder. What counts as a problem is written in the skill's script, so changing a detection rule means changing that script.

### What about problems the rules do not catch?

The detection rules are a floor. When it notices a problem no rule covers, it says so briefly before the table, but it does not promise to find every problem.

## limits

- Gives no legal advice and never says whether to sign.
- Never gives a reason that is not in the text of the contract, such as the counterparty's intent or industry practice.
- Never saves a redline without legal's approval.
