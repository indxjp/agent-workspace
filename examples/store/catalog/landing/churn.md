# ja

## headline

顧客ごとの利用状況をその顧客の過去の水準と比べ、解約の兆候がある顧客とどの兆候が出ているかを、グラフと計算どおりの数値で示す。

## audience

カスタマーサクセスの担当者、契約の更新を担当する営業の担当者

## problem

担当者が管理画面から顧客ごとの利用状況を書き出し、利用者数やログイン数が前の月より減っていないかを一社ずつ見比べている。見る項目や基準が担当者によって違い、気づいたときには契約の更新が近づいていることがある。

## steps

1. [] 受け取る：サービスの管理画面から書き出した、月・顧客ごとの契約席数・利用者数・ログイン数・問い合わせ件数のCSVを受け取る。
2. [] 調べる：依頼された月と、その前の数か月の利用状況を顧客ごとに読み取る。
3. [] 判断する：決まったルールで計算するスクリプトが、顧客ごとに過去の水準と比べて、利用者数やログイン数の減少、契約席数の削減、問い合わせの増加、利用率の低さの兆候を判定し、兆候の多い顧客を挙げる。
4. [] 人が確認する：兆候のある顧客とその兆候、顧客別の利用率のグラフを、担当者が確かめる。
5. [] 書き込む：顧客への連絡もファイルの書き込みもせず、結果を表とコメントで返す。

## outputs

- 兆候のある顧客の一覧：顧客名、兆候、利用者数とログイン数の過去の水準からの変化、問い合わせ件数、利用率
- 兆候のある顧客ごとの兆候の数と、顧客別の利用率の棒グラフ
- 比べる前の月がなく評価していない顧客と、担当者が確かめられることの案を書いたコメント

## faq

### 解約するかどうかを予測するのですか？

いいえ。利用状況に出ている兆候を決まったルールで示すだけで、予測ではありません。理由も推測しません。どう対応するかは担当者が決めます。

### 社員の退職の予測にも使えますか？

使えません。取引先の顧客アカウントの利用状況だけを読みます。社員や応募者など個人が辞めるかどうかを予測する依頼には応じません。

### 自社のサービスの書き出しを使えますか？

年月・顧客ID・顧客名・契約席数・利用者数・ログイン数・問い合わせ件数の列があるCSV（UTF-8）か、Excelのファイル（.xlsx、最初のシート）を読みます。列名は日本語と英語のどちらでも構いません。

### 兆候をいくつ満たしたら挙げるかを変えられますか？

依頼の中で兆候の数を伝えると、その数以上の顧客を挙げます。伝えないときは決まった数を使います。

## limits

- 社員や個人が辞めるかどうかを予測・判断しない。顧客アカウントだけを扱う。
- 兆候を予測や確実なこととして示さず、理由を推測しない。
- 顧客への連絡やメールの送付をしない。
- 利用状況のファイルを書き換えたり、保存したり、送ったりしない。

# en

## headline

Compares each customer account's usage with its own past level, and shows which accounts show signs of leaving and which signs, with charts and exactly the computed numbers.

## audience

Customer success managers, and account managers who handle renewals

## problem

Someone exports each account's usage from the admin console and checks, one account at a time, whether active users or logins fell from the month before. What each person looks at and where they draw the line differ, and a falling account is sometimes noticed only as its renewal nears.

## steps

1. [] Receive: takes the CSV of seats, active users, logins and support tickets by month and account that your service's admin console exports.
2. [] Look up: reads each account's usage in the month asked for and the months before it.
3. [] Decide: a script that applies fixed rules compares each account with its own past level, finds the signs (fewer active users or logins, seats cut, more support tickets, low adoption), and lists the accounts with the most signs.
4. [] A person confirms: a person checks the accounts with signs, the signs themselves and the chart of adoption by account.
5. [] Write: contacts no customer and writes no file, and returns the result as a table and commentary.

## outputs

- A list of the accounts with signs: name, signs, change in active users and logins from their past level, support tickets and adoption
- Bar charts of the number of signs of each account with signs, and of adoption by account
- Commentary naming the accounts with no earlier month to compare with, and ideas for what a person might check

## faq

### Does it predict whether a customer will leave?

No. It shows the signs in the usage by fixed rules; it is not a prediction, and it does not guess reasons. A person decides what to do.

### Can it predict which employees will leave?

No. It reads customer accounts' usage only, and declines to predict whether an employee, a candidate or any other person will leave.

### Can it read our service's export?

It reads a CSV (UTF-8) or an Excel file (.xlsx, its first sheet) with columns for the month, account ID, account name, seats, active users, logins and support tickets, named in Japanese or English.

### Can I change how many signs put an account on the list?

Name a number of signs in your request and it lists the accounts with that many or more. Otherwise it uses its default.

## limits

- Never predicts or judges whether an employee or any person will leave; reads customer accounts only.
- Never presents a sign as a prediction or a certainty, and never guesses a reason.
- Never contacts customers or sends emails.
- Never changes, saves or sends the usage files.
