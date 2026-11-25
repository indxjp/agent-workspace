# ja

## headline

OKRツールのチェックインから、主要な結果ごとの進み具合を期待値と比べ、遅れているものと更新のないものを毎週まとめる。人の評価はしない。

## audience

OKRの進み具合を確認する経営企画やチームリーダー、週次の定例で進捗を共有する担当者

## problem

毎週、担当者がOKRツールの画面を一つずつ開き、どの主要な結果が遅れているか、誰が更新していないかを拾って定例の資料にまとめている。期待値と比べずに数字だけを並べたり、更新のない主要な結果を見落としたりする。

## steps

1. [] 受け取る：毎週月曜の朝に自動で始まる。担当者がチェックインの日付を指定して頼むこともできる。
2. [] 調べる：OKRツールから書き出したOKR一覧とチェックインを読む。
3. [] 判断する：主要な結果ごとに、ツールが計算した進捗率を期待値と比べ、順調・遅れ・更新なしに分け、チェックインの行を出典として示す。人の評価はしない。
4. [] 人が確認する：保存する前に、担当者の承認を待つ。
5. [] 書き込む：承認された一回の保存で、進捗レポートを報告のフォルダに書く。

## outputs

- 遅れと更新のない主要な結果を先に並べ、チェックインの行を出典にした進捗レポート（Markdown）
- 主要な結果ごとの進捗率・期待値・状態の型付きの結果と、進捗率のグラフ
- 従わなかったチェックインの中の指示があれば、その一文

## faq

### 進捗率は自分で計算しますか？

しません。OKRツールが計算した進捗率と期待値をそのまま写し、比べるだけです。数値を計算し直したり、丸めたりはしません。

### 誰の成果が低いかを比べられますか？

比べません。OKRの進み具合は人事評価ではないため、オーナーやチームの評価・順位づけ・比較は頼まれてもしません。代わりに主要な結果の進み具合を示します。

### 自社のOKRツールでも使えますか？

OKR一覧とチェックインをCSVで書き出せるツールなら、そのファイルを自社のフォルダに置けば読めます。列の名前が違うときは、担当者が指示の列名を合わせて直す必要があります。

## limits

- オーナーやチームを評価・順位づけ・比較しない。判断は人が行う。
- 進捗率を計算し直さず、目標値やチェックインを書き換えない。
- チームやオーナーにメールやチャットで連絡しない。

# en

## headline

From the OKR tool's check-ins, compares each key result's progress with the progress expected by now, and lists every week which are behind and which have no update. It never rates anyone.

## audience

Strategy staff and team leads who track OKRs, and whoever shares progress at the weekly meeting

## problem

Each week someone opens the OKR tool one key result at a time, picks out which are behind and who has not updated, and copies it into the meeting deck. Numbers get listed without the expected progress beside them, and a key result nobody updated is missed.

## steps

1. [] Receive: starts automatically every Monday morning, or when a person names a check-in date.
2. [] Look up: reads the OKR list and the check-ins exported from the OKR tool.
3. [] Decide: compares each key result's progress, as the tool computed it, with the expected progress, and marks it on track, behind or without an update, citing the check-in row. It rates nobody.
4. [] A person confirms: waits for approval before saving.
5. [] Write: saves the progress report to the reports folder in the one approved call.

## outputs

- A progress report in Markdown, with the key results behind or without an update first and the check-in rows as sources
- A typed result with each key result's progress, expected progress and status, and a chart of the progress
- One sentence about any instruction in a check-in that it did not follow

## faq

### Does it compute the progress itself?

No. It copies the progress and the expected progress the OKR tool computed, and only compares them. It never recomputes or rounds a number.

### Can it compare whose results are weaker?

No. OKR progress is not a performance review, so it never rates, ranks or compares owners or teams, even when asked. It shows the key results' progress instead.

### Does it work with our own OKR tool?

If your tool exports the OKR list and the check-ins as CSV, put those files in your own folder and it reads them. When the column names differ, someone must update the instructions’ column names to match.

## limits

- Never rates, ranks or compares owners or teams: a person decides.
- Never recomputes progress, and never changes a target or a check-in.
- Never contacts teams or owners by email or chat.
