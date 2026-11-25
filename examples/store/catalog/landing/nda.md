# ja

## headline

受け取ったNDAを自社のひな形と条項ごとに比べ、違いと修正案を一覧にする。

## audience

法務部の担当者、取引の前にNDAを取り交わす営業・購買の担当者

## problem

取引の前に相手方から届くNDAを、担当者が自社のひな形と並べて読み比べている。秘密情報の範囲、有効期間、返還や破棄の定めなど、ひな形との違いを探す作業は件数が増えるほど後回しになりやすい。

## steps

1. [] 受け取る：相手方から届いたNDAのファイルを受け取る。
2. [] 調べる：自社のNDAのひな形と審査基準を、条項ごとに照らす。
3. [] 判断する：違いごとに「OK・要注意・NG」の判定と修正案を付ける。
4. [] 人が確認する：差分レポートを保存する前に、担当者の承認を待つ。
5. [] 書き込む：承認された差分レポートだけを、レポート用のフォルダに保存する。

## outputs

- 審査基準の項目ごとに、受け取ったNDAの該当条項、判定、理由、ひな形の文言にもとづく修正案を並べた差分表
- 承認のあとレポート用のフォルダに保存される、Markdown形式の差分レポート

## faq

### 自社のひな形を使えますか？

ひな形と審査基準は、自社のフォルダに置くファイルです。差し替えると、その内容と比べます。

### 相手方への返信も作りますか？

作りません。差分と修正案までを示し、相手方とのやり取りは担当者が行います。

### どの形式のNDAを読めますか？

テキストとMarkdownのファイルはそのまま読みます。WordとPDFのファイルは読み取り用のスクリプトで読み、そのスクリプトを動かす前に担当者の承認を待ちます。画像だけのPDFの文字は読めないため、読めなかったことを伝えます。

## limits

- 法的助言はせず、署名してよいかどうかも判断しない。
- 相手方にファイルやメッセージを送らない。
- ひな形と審査基準にない論点には、判定を付けない。

# en

## headline

Compares an incoming NDA with your template clause by clause, and lists each difference with a suggested fix.

## audience

People in legal, and sales and purchasing staff who exchange NDAs before a deal

## problem

Before a deal, the counterparty sends an NDA and someone reads it side by side with the company's template. Finding where it differs, in the scope of confidential information, the term, or the rules for returning and destroying it, is easy to put off as more of them arrive.

## steps

1. [] Receive: takes the NDA file the counterparty sent.
2. [] Look up: checks it clause by clause against your NDA template and review standards.
3. [] Decide: marks each difference OK, caution or NG, with a suggested fix.
4. [] A person confirms: waits for approval before saving the difference report.
5. [] Write: saves only the approved difference report to the nda-reports folder.

## outputs

- A table of differences, one row per item of your review standards: the matching clause of the NDA you received, the verdict, the reason and a suggested fix based on your template's wording
- A difference report in Markdown, saved to the nda-reports folder once it is approved

## faq

### Can it use our own template?

The template and the review standards are files in your own folder. Replace them and it compares against what they say.

### Does it write the reply to the counterparty?

No. It shows the differences and suggested fixes; a person handles the exchange with the counterparty.

### Which file formats can it read?

It reads text and Markdown files directly. It reads Word and PDF files with a reading script, and waits for a person's approval before that script runs. It cannot read the text of a PDF that is only scanned images, and says so.

## limits

- Gives no legal advice and never decides whether to sign.
- Never sends a file or a message to the counterparty.
- Gives no verdict on points that neither the template nor the review standards cover.
