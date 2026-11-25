# ja

## headline

アプリケーションのログから、エラーが集中した時間帯とエラーのパターンを、秘密情報や個人情報を伏せたまま示す。

## audience

情報システム・開発・運用の担当者

## problem

障害が起きると、ログ基盤から大量のログを書き出し、いつからエラーが増えたのか、どの種類のエラーが多いのかを目で追っている。ログにはパスワードやメールアドレスが紛れ込んでいることがあり、調べた結果をそのまま共有すると情報が漏れるおそれもある。

## steps

1. [] 受け取る：ログ基盤から書き出した、日時・レベル・サービス・メッセージのCSVを受け取る。
2. [] 調べる：最初の行から最後の行まで、決まった長さの時間帯ごとにエラーと警告を数える。
3. [] 判断する：決まった規則で動くスクリプトが、エラーが最も多い時間帯を求め、秘密情報や個人情報を伏せて、エラーと警告を同じ形のメッセージごとにまとめる。
4. [] 人が確認する：どこを直すかは、担当者が決める。
5. [] 書き込む：ファイルやシステムには書き込まず、結果を表とグラフで返す。

## outputs

- エラーが最も多い時間帯と、その件数
- エラーと警告のパターンの一覧：レベル、サービス、伏せた形のメッセージ、件数、最初と最後の時刻
- 伏せた値の数と、時間帯別のエラー件数のグラフ

## faq

### ログにパスワードやメールアドレスが入っていても大丈夫ですか？

スクリプトが、パスワード・トークン・APIキー・メールアドレス・IPアドレスを伏せてからメッセージをまとめ、伏せた数だけを示します。値そのものは答えに書きません。

### 時間帯の長さやサービスは指定できますか？

はい。依頼の中で時間帯の長さ（分単位）やサービス名を指定すると、その条件で数えます。

### エラーの原因も教えてくれますか？

ログに書かれていることだけを示し、ログにない原因は推測しません。どこを直すかは担当者が決めます。

### どんな形式のデータを読めますか？

日時・レベル・サービス・ホスト・メッセージの列があるCSV（UTF-8）か、Excelのファイル（.xlsx、最初のシート）を読みます。列名は日本語と英語のどちらでも構いません。

## limits

- ログの中のパスワード・トークン・APIキー・メールアドレス・IPアドレスを答えに書かない。
- ログにない原因を推測しない。
- サーバーの再起動や設定の変更、チャットへの投稿はせず、ファイルも書き換えない。
- 読めない日時や、複数の時差が混ざった日時があれば推測せず、計算せずにその行を伝える。

# en

## headline

Shows when the errors in your application logs clustered and which patterns they follow, with secrets and personal data kept masked.

## audience

IT, development and operations staff

## problem

When something breaks, someone exports a mass of logs from the log platform and follows them by eye to see when the errors started and which kinds are most frequent. Logs can carry stray passwords and e-mail addresses, and sharing the findings as they are risks leaking them.

## steps

1. [] Receive: takes the CSV of timestamps, levels, services and messages that your log platform exports.
2. [] Look up: counts the errors and warnings in fixed time buckets from the first line to the last.
3. [] Decide: a script that works by fixed rules finds the bucket with the most errors, masks secrets and personal data, and groups the errors and warnings by message pattern.
4. [] A person confirms: a person decides what to fix.
5. [] Write: writes nothing to a file or a system, and returns the result as a table and a chart.

## outputs

- The time bucket with the most errors, and how many it held
- The error and warning patterns: level, service, masked message, count, first and last seen
- How many values were masked, and a chart of the errors by time

## faq

### What if the logs hold passwords or e-mail addresses?

The script masks passwords, tokens, API keys, e-mail addresses and IP addresses before it groups the messages, and shows only how many it masked. The values themselves never appear in the answer.

### Can I choose the bucket length or a service?

Yes. Name an interval (a number of minutes that divides an hour) or a service in your request, and it counts by that.

### Does it tell me the cause?

It shows only what the logs say, and never guesses a cause they do not show. A person decides what to fix.

### What data can it read?

A CSV (UTF-8) or an Excel file (.xlsx, its first sheet) with columns for the timestamp, level, service, host and message, named in Japanese or English.

## limits

- Never writes a password, token, API key, e-mail address or IP address from the logs in its answer.
- Never guesses a cause the logs do not show.
- Never restarts a server, changes a setting, posts to a chat, or changes a file.
- Never guesses a timestamp it cannot read, or timestamps written with mixed offsets: it computes nothing and names the row.
