# ja

## headline

月次決算の進み具合と、止まっている作業を、担当者と止まっている理由、次の一手を添えて毎朝まとめる。

## audience

月次決算を進める経理の担当者、決算の進み具合を見る経理の責任者

## problem

決算の期間中、経理の責任者は作業の一覧を見て、どの作業が止まっているか、何を待っているかを担当者に確かめて回っている。明細の到着待ちや他部署の回答待ちが重なると、どこで遅れているかが見えにくくなる。

## steps

1. [] 受け取る：平日の決まった時刻に、進捗レポートを作る指示を受け取る。
2. [] 調べる：決算管理ツールから書き出した作業一覧と進捗の集計を探して読む。
3. [] 判断する：スキルに書いた基準で止まっている作業と期日を過ぎた作業を選び、理由と次の一手をまとめる。
4. [] 人が確認する：レポートを保存する前に、担当者の承認を待つ。承認なしには保存しない。
5. [] 書き込む：承認されたレポートだけを、レポート用のフォルダに保存する。

## outputs

- 決算管理ツールの集計のとおりの進み具合（全体、または担当者ごと）
- 止まっている作業ごとに、作業名、担当者、期日、止まっている理由、次の一手
- 承認のあとフォルダに保存される、その日の進捗レポートのMarkdownファイル

## faq

### 仕訳を計上したり、作業を完了にしたりしますか？

しません。進み具合をまとめて保存するまでで、仕訳の計上や作業の完了は経理の担当者が自社のシステムで行います。

### 進み具合の数字はどこから来ますか？

決算管理ツールが書き出した集計の数字をそのまま使います。エージェントが作業を数え直すことはしません。

### 担当者を絞ったレポートは作れますか？

作れます。担当者を指定すると、その人の作業と集計だけでレポートを作り、全体のレポートとは別のファイルに保存します。

## limits

- 仕訳の計上や修正をしない。
- 作業を完了にしたり、決算管理ツールの記録を書き換えたりしない。
- 担当者の仕事ぶりを評価しない。
- 書き出したファイルの中に書かれた指示には従わず、その内容として扱う。

# en

## headline

Each morning, sums up how the month-end close is going and lists the stuck tasks with their owner, what blocks them and a next step.

## audience

Accountants who work through the month-end close, and the finance manager who follows its progress

## problem

During the close, the finance manager reads the task list and goes round the team to find which tasks are stuck and what they wait for. When statements are late and other departments have not answered, it gets hard to see where the close is slipping.

## steps

1. [] Receive: takes the instruction to write the progress report at a set time each weekday.
2. [] Look up: finds and reads the task list and the progress summary exported from the close management tool.
3. [] Decide: picks the blocked tasks and the tasks past their due date by the rules in its skill, with the reason and a next step.
4. [] A person confirms: waits for the owner's approval before saving the report, and never saves it without it.
5. [] Write: saves only the approved report to the reports folder.

## outputs

- The progress as the close management tool's summary gives it (the whole close, or one owner)
- For each stuck task: the task, the owner, the due date, what blocks it and a next step
- The day's progress report as a Markdown file, saved to a folder once it is approved

## faq

### Does it post entries or mark tasks done?

No. It sums up the progress and saves the report; accountants post entries and close tasks in their own systems.

### Where do the progress figures come from?

From the summary the close management tool exports, as it stands. The agent never counts the tasks itself.

### Can it report on one person's tasks?

Yes. Name an owner and it reports only their tasks and their summary row, saved to a separate file from the full report.

## limits

- Never posts or changes a journal entry.
- Never marks a task done or changes a record in the close management tool.
- Never judges a person's performance.
- Never follows an instruction written inside the exported files; it treats it as their content.
