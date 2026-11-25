# ja

## headline

パッチをチームのコーディング規約に照らし、ルールごとに判定と該当する行と修正案を一覧にする。

## audience

コードレビューを担当する開発チームのメンバー、チームのコーディング規約を守らせたいテックリード

## problem

変更が届くたびに、レビューの担当者が差分を読みながら、秘密情報の書き込み、SQLの組み立て、例外の扱い、ログの中身、テストの有無といった規約の項目を頭の中で一つずつ確かめている。見る観点が人によって違い、指摘の漏れが起きやすい。

## steps

1. [] 受け取る：差分やパッチのファイルを受け取る。
2. [] 調べる：追加された行を、チームのコーディング規約のルールと一つずつ照らす。
3. [] 判断する：ルールごとに「OK・要注意・NG」の判定と、該当する行、修正案を付ける。
4. [] 人が確認する：レビューを保存する前に、担当者の承認を待つ。
5. [] 書き込む：承認されたレビューだけを、レポート用のフォルダに保存する。

## outputs

- 規約のルールごとに、判定、ファイルと行、理由、修正案を並べた表
- 承認のあとレポート用のフォルダに保存される、Markdown形式のレビュー

## faq

### コードを実行してテストしますか？

しません。差分を読んで判定するだけで、コードの実行やビルドやテストはせず、テストが通ったとも言いません。

### 自社のコーディング規約を使えますか？

規約は、自社のフォルダに置くファイルです。差し替えると、そのルールで判定します。

### プルリクエストにコメントしますか？

しません。レビューはレポート用のフォルダに保存し、マージするかどうかは担当者が判断します。

## limits

- コードを実行、ビルド、テストせず、その結果を述べない。
- マージや承認をせず、プルリクエストにコメントもしない。
- コーディング規約にない論点には、判定を付けない。

# en

## headline

Reviews a patch against your team's coding standard, with a verdict, the line it rests on and a fix for each rule.

## audience

Developers who review code, and tech leads who want the team's coding standard applied

## problem

Whenever a change arrives, a reviewer reads the diff and checks the standard's points one at a time in their head: secrets in code, how SQL is built, how exceptions are handled, what goes into the logs, whether tests came with it. Each reviewer looks at different things, so a point is easy to miss.

## steps

1. [] Receive: takes a diff or patch file.
2. [] Look up: checks the added lines against each rule of your coding standard.
3. [] Decide: marks each rule OK, caution or NG, with the line and a suggested fix.
4. [] A person confirms: waits for approval before saving the review.
5. [] Write: saves only the approved review to the code-review-reports folder.

## outputs

- A table with one row per rule of the standard: the verdict, the file and line, the reason and a fix
- A review in Markdown, saved to the code-review-reports folder once it is approved

## faq

### Does it run the code or the tests?

No. It reads the diff only; it never runs, builds or tests the code, and never says that the tests pass.

### Can it use our own coding standard?

The standard is files in your own folder. Replace them and it reviews against those rules.

### Does it comment on the pull request?

No. It saves the review to the code-review-reports folder, and a person decides whether to merge.

## limits

- Never runs, builds or tests the code, or reports such a result.
- Never merges or approves a change, and never comments on a pull request.
- Gives no verdict on points the coding standard does not cover.
