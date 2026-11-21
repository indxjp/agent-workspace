# ja

## headline

検査記録を検査基準書と項目ごとに照らし、規格外れと記入漏れを一覧にする。

## audience

品質保証部の担当者、検査記録を確認する製造現場の責任者

## problem

検査記録は、出荷の前に担当者が検査基準書と並べて、測定値が規格の範囲に入っているか、記入漏れがないかを一行ずつ確かめている。ロットが重なると、確認が出荷の直前に集中しやすい。

## steps

1. [] 受け取る：検査記録のファイルを受け取る。
2. [] 調べる：その品番の検査基準書の規格と判定基準を読む。
3. [] 判断する：検査項目ごとに「OK・要注意・NG」の判定と、基準書の処置を付ける。
4. [] 人が確認する：チェック結果の報告書を保存する前に、担当者の承認を待つ。
5. [] 書き込む：承認された報告書だけを、報告書用のフォルダに保存する。

## outputs

- 検査項目ごとに、記録された値、判定、理由（どのサンプルのどの値か）、検査基準書の処置を並べたチェック表
- 承認のあと報告書用のフォルダに保存される、Markdown形式のチェック報告書

## faq

### いつ使えるようになりますか？

まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。

### ロットを出荷してよいかを決めますか？

決めません。規格外れと記入漏れを示し、基準書の処置を添えるまでです。ロットの処置は品質保証の担当者が決めます。

### 自社の検査基準書を使えますか？

検査基準書は、自社のフォルダに置くファイルです。差し替えると、その規格と判定基準で照らします。

### どの形式の検査記録を読めますか？

CSVとテキストのファイルはそのまま読みます。ExcelとPDFのファイルは読み取り用のスクリプトで読み、そのスクリプトを動かす前に担当者の承認を待ちます。

## limits

- ロットの出荷・手直し・廃却を決めない。
- 検査基準書の規格や公差を変えない。
- 空欄の測定値を推測で埋めない。
- 検査基準書にない論点には、判定を付けない。

# en

## headline

Checks an inspection record against the inspection standard item by item, and lists out-of-spec values and missing entries.

## audience

Quality assurance staff, and production leads who sign off inspection records

## problem

Before a lot ships, someone puts the inspection record beside the inspection standard and checks line by line that each measurement is within its limits and nothing is left blank. When lots overlap, those checks tend to pile up right before shipping.

## steps

1. [] Receive: takes the inspection record file.
2. [] Look up: reads the specification and the rule of the inspection standard for that part.
3. [] Decide: marks each inspection item OK, caution or NG, with the action the standard names.
4. [] A person confirms: waits for approval before saving the check report.
5. [] Write: saves only the approved report to the inspection-reports folder.

## outputs

- A check table, one row per inspection item: the recorded values, the verdict, the reason (which sample and which value) and the standard's action
- A check report in Markdown, saved to the inspection-reports folder once it is approved

## faq

### When can I use it?

It is not live yet. Sign up for a launch notice and we will email you when it opens.

### Does it decide whether the lot ships?

No. It shows out-of-spec values and missing entries with the standard's action. A person in quality assurance decides what happens to the lot.

### Can it use our own inspection standard?

The inspection standard is a set of files in your own folder. Replace them and it checks against their specifications and rules.

### Which file formats can it read?

It reads CSV and text files directly. It reads Excel and PDF files with a reading script, and waits for a person's approval before that script runs.

## limits

- Never decides whether a lot ships, is reworked or is scrapped.
- Never changes a specification or a tolerance.
- Never fills in a blank measurement by guessing.
- Gives no verdict on points the inspection standard does not cover.
