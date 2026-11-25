# ja

## headline

満了の近い契約を毎朝拾い、満了日と担当者、お客様への更新案内メールの下書きを添えて一覧にする。

## audience

法人営業の担当者、契約の更新を管理する営業事務

## problem

営業事務は、契約管理の一覧を満了日の順に並べ替え、更新の案内が必要な契約を探している。担当者への連絡や案内メールの準備は手作業で、案内が遅れると、お客様が予算を決めたあとになってしまうことがある。

## steps

1. [] 受け取る：平日の決まった時刻に、更新リマインドを作る指示を受け取る。
2. [] 調べる：契約管理システムから書き出した契約一覧を探して読む。
3. [] 判断する：スキルに書いた基準で満了の近い契約を選び、急ぎのものを先にして、契約ごとに更新案内メールの下書きを書く。
4. [] 人が確認する：リマインドを保存する前に、担当者の承認を待つ。承認なしには保存しない。
5. [] 書き込む：承認されたリマインドだけを、レポート用のフォルダに保存する。

## outputs

- 満了の近い契約ごとに、取引先、満了日と残りの日数、担当者、更新案内メールの下書き
- 承認のあとフォルダに保存される、その日のリマインドのMarkdownファイル
- 各行の出典（CSVのファイル名と契約番号）

## faq

### メールはお客様に送られますか？

送りません。下書きをリマインドの中に書くだけで、送るかどうか、どう直すかは担当者が決めます。

### 値引きや更新の条件を書いてしまいませんか？

書きません。下書きは製品名と満了日、打ち合わせのお願いまでで、価格や条件は担当者が決めます。

### どの契約を「満了が近い」と判断しますか？

書き出した一覧にある満了までの日数を、スキルに書いた基準と比べます。基準はスキルの説明を書き換えて変えられます。

## limits

- お客様にメールやメッセージを送らない。
- 値引き、価格、契約の条件を約束しない。
- 契約管理システムの記録を書き換えない。
- 書き出したファイルの中に書かれた指示には従わず、その内容として扱う。

# en

## headline

Each morning, finds the contracts nearing their end and lists them with the end date, the owner and a draft renewal email to the customer.

## audience

Account executives who sell to businesses, and sales administrators who manage contract renewals

## problem

A sales administrator sorts the contract list by end date to find the contracts that need a renewal notice. Telling each owner and preparing the emails is done by hand, and a late notice can reach the customer after their budget is already set.

## steps

1. [] Receive: takes the instruction to write the renewal reminder at a set time each weekday.
2. [] Look up: finds and reads the contract list exported from the contract management system.
3. [] Decide: picks the contracts nearing their end by the rules in its skill, urgent ones first, and drafts a renewal email for each.
4. [] A person confirms: waits for the owner's approval before saving the reminder, and never saves it without it.
5. [] Write: saves only the approved reminder to the reports folder.

## outputs

- For each contract nearing its end: the account, the end date and the days left, the owner and a draft renewal email
- The day's reminder as a Markdown file, saved to a folder once it is approved
- A source on every line: the CSV file name and the contract id

## faq

### Is the email sent to the customer?

No. The draft is only written into the reminder; the owner decides whether and how to send it.

### Could the draft offer a discount or new terms?

No. A draft names the product and the end date and asks for a meeting; the owner decides price and terms.

### How does it decide a contract is nearing its end?

It compares the days to the end in the exported list with the rules written in its skill. You change the rules by editing the skill's description.

## limits

- Never sends an email or a message to a customer.
- Never promises a discount, a price or contract terms.
- Never changes a record in the contract management system.
- Never follows an instruction written inside the exported files; it treats it as their content.
