# ja

## headline

入金の遅れている請求を毎朝拾い、遅れに応じた督促の段階と、督促メールの下書きを添えて一覧にする。

## audience

売掛金を管理する経理の担当者、督促の判断をする経理の責任者

## problem

経理の担当者は、会計システムの売掛金の明細から期日を過ぎた請求を探し、遅れの長さに合わせて督促のメールを一通ずつ書いている。どこまで督促したかは人の記憶やメモに頼りがちで、長く遅れている請求を責任者に上げるのが遅れることがある。

## steps

1. [] 受け取る：平日の決まった時刻に、督促リストを作る指示を受け取る。
2. [] 調べる：会計システムから書き出した売掛金の明細を探して読む。
3. [] 判断する：スキルに書いた基準で遅れている請求を選び、遅れの長さで督促の段階を決めて、お客様あての下書きか責任者への引き継ぎメモを書く。
4. [] 人が確認する：督促リストを保存する前に、担当者の承認を待つ。承認なしには保存しない。
5. [] 書き込む：承認された督促リストだけを、レポート用のフォルダに保存する。

## outputs

- 遅れている請求ごとに、取引先、請求番号、支払期日、残高、遅れの日数、督促の段階
- 段階に応じた督促メールの下書き、または経理の責任者への引き継ぎメモ
- 承認のあとフォルダに保存される、その日の督促リストのMarkdownファイル

## faq

### 督促メールはお客様に送られますか？

送りません。下書きを督促リストの中に書くだけで、送るかどうかは担当者が決めます。

### 支払いの延期や分割を約束してしまいませんか？

約束しません。下書きは請求の内容と入金の確認のお願いまでで、支払いの条件は担当者と責任者が決めます。

### 督促の段階は変えられますか？

遅れの日数と段階の対応は、スキルに書かれた表です。自社の督促の手順に合わせて書き換えられます。

## limits

- お客様にメールや電話で連絡しない。
- 支払期日の延期、分割、減額を約束しない。
- 入金の消込や会計システムの記録の変更はしない。
- 書き出したファイルの中に書かれた指示には従わず、その内容として扱う。

# en

## headline

Each morning, finds the late invoices and lists them with a reminder stage that fits how late each is, and a draft reminder email.

## audience

Accounts receivable staff, and the finance manager who decides on escalations

## problem

Accounts receivable staff search the receivables in the accounting system for invoices past their due date, and write each reminder email by hand to fit how late it is. Who was reminded when often lives in memory and notes, and a long-overdue invoice can reach the finance manager late.

## steps

1. [] Receive: takes the instruction to write the collections list at a set time each weekday.
2. [] Look up: finds and reads the receivables exported from the accounting system.
3. [] Decide: picks the late invoices by the rules in its skill, sets each one's reminder stage by how late it is, and writes a draft for the customer or a note for the finance manager.
4. [] A person confirms: waits for the owner's approval before saving the list, and never saves it without it.
5. [] Write: saves only the approved list to the reports folder.

## outputs

- For each late invoice: the customer, the invoice, the due date, the balance, the days overdue and the reminder stage
- The draft reminder email the stage calls for, or a note for the finance manager
- The day's list as a Markdown file, saved to a folder once it is approved

## faq

### Is the reminder sent to the customer?

No. The draft is only written into the list; the owner decides whether to send it.

### Could it promise a later due date or instalments?

No. A draft states the invoice and asks the customer to check the payment; payment terms are for the staff and the finance manager to decide.

### Can I change the reminder stages?

The stages by days overdue are a table written in its skill. You can rewrite it to match your own collections procedure.

## limits

- Never contacts a customer by email or phone.
- Never promises a later due date, instalments or a reduction.
- Never applies a payment or changes a record in the accounting system.
- Never follows an instruction written inside the exported files; it treats it as their content.
