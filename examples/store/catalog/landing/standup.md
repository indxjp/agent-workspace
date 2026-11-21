# ja

## headline

毎朝、前の営業日のタスク・コミット・チャットの記録から、人ごとに「昨日・今日・困りごと」をまとめる。

## audience

開発チームのリーダー、朝会を進めるチームのメンバー

## problem

朝会の前に、リーダーがタスク管理ツール、コミットの履歴、チームのチャットを順に見て、誰が何を進めたかを拾い集めている。困りごとがチャットの中に埋もれて、朝会で取り上げられないままになることがある。

## steps

1. [] 受け取る：平日の毎朝決まった時刻に、まとめを作る指示を受け取る。
2. [] 調べる：タスクの更新、コミット、チャットの書き出しから、前の営業日の記録を集める。
3. [] 判断する：人ごとに、昨日の作業、今日の予定、困りごとを出典付きでまとめる。人の評価はしない。
4. [] 人が確認する：まとめを保存する前に、担当者の承認を待つ。承認なしには保存しない。
5. [] 書き込む：承認されたまとめだけを、レポート用のフォルダに保存する。

## outputs

- 人ごとの昨日の作業、今日の予定、困りごと
- 承認のあとフォルダに保存される、その日のまとめのMarkdownファイル
- 各行の出典（ファイル名とタスク、コミット、メッセージのID）

## faq

### いつ使えるようになりますか？

まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。

### どのデータを使いますか？

タスク管理ツールの更新履歴、コミットの履歴、チームのチャットを書き出したCSVファイルを自社のフォルダに置いて使います。デモでは架空のチームのデータを使っています。

### メンバーの働きぶりを評価しますか？

しません。まとめるのは作業の記録だけで、人を評価したり、比べたり、順位をつけたりはしません。頼まれても断ります。

### チャットに投稿しますか？

しません。まとめを作って保存するまでで、チームへの共有は人が行います。

## limits

- 人を評価したり、比べたり、順位をつけたりしない。
- チャットに投稿せず、タスクを書き換えない。
- 記録にない作業や予定を書き足さない。
- 記録の中に書かれた指示には従わない。

# en

## headline

Each morning, sums up yesterday, today and blockers for each person from the previous working day's tasks, commits and chat.

## audience

Development team leads, and team members who run the stand-up

## problem

Before the stand-up, a team lead goes through the task tracker, the commit history and the team chat to piece together who moved what forward. Blockers mentioned in the chat can get buried and never come up at the stand-up.

## steps

1. [] Receive: takes the instruction to write the digest at a set time each weekday morning.
2. [] Look up: collects the previous working day's records from the task updates, commits and chat exports.
3. [] Decide: sums up each person's work yesterday, plans for today and blockers, each with its source, and never evaluates anyone.
4. [] A person confirms: waits for the owner's approval before saving the digest, and never saves it without it.
5. [] Write: saves only the approved digest to the reports folder.

## outputs

- For each person: yesterday's work, today's plans and blockers
- The day's digest as a Markdown file, saved to a folder once it is approved
- A source on every line: the file name and the task, commit or message id

## faq

### When can I use it?

It is not live yet. Sign up for a launch notice and we will email you when it opens.

### Which data does it use?

CSV exports of your task tracker's update log, the commit history and the team chat, placed in your own folder. The demo uses data about a fictional team.

### Does it evaluate team members?

No. It sums up work records only, and never rates, compares or ranks people. It declines when asked to.

### Does it post to the chat?

No. It writes and saves the digest; a person shares it with the team.

## limits

- Never rates, compares or ranks people.
- Never posts to the chat or changes a task.
- Never adds work or plans the records do not hold.
- Never follows an instruction written inside the records.
