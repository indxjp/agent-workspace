# ja

## headline

マージ済みのプルリクエストの一覧から、種類ごとにまとめた利用者向けのリリースノートの下書きを Word で作る。

## audience

ソフトウェアのプロダクト担当者、リリースを取りまとめる開発チームのリーダー

## problem

リリースのたびに、担当者がプルリクエストの一覧を見返し、利用者に関係する変更を拾って種類ごとに書き直している。開発向けの変更が紛れ込んだり、一覧にない効果を書き足したりしやすい。

## steps

1. [] 受け取る：リリースに含まれるマージ済みプルリクエストの一覧を受け取る。
2. [] 調べる：チームのリリースノートの書き方を読み、載せる変更と載せない変更を分ける。
3. [] 判断する：互換性・セキュリティ・新機能・不具合の修正の順に、プルリクエスト番号付きで構成を回答に示す。
4. [] 人が確認する：Word のファイルを書き出す前に、担当者の承認を待つ。
5. [] 書き込む：承認された一回の書き出しで、リリースノートを Word のファイルにする。

## outputs

- 種類ごとの項目に、もとのプルリクエスト番号を添えたリリースノートの構成（回答の中に表示）
- 承認のあと書き出される、リリースノートの Word ファイル（.docx）
- 載せなかったプルリクエストとその理由、リリース日など担当者が埋める確認事項

## faq

### 一覧にない変更を書くことはありますか？

書きません。載せるのは一覧にあるプルリクエストだけで、タイトルと説明に書かれていない効果や今後の予定は足しません。

### 開発者向けの変更はどうなりますか？

書き方のルールで載せないとされたラベルの変更は、文書に入れず、載せなかった理由とともに回答で示します。

### 自社の書き方に合わせられますか？

書き方のルールは自社のフォルダに置くファイルです。グループや順番を書き換えると、その内容に沿って構成を作ります。

## limits

- リリースノートを公開したり、利用者に送ったりしない。
- 一覧にない変更・効果・予定を書かない。
- コードのレビューやマージはしない。
- Markdown やウェブページの形では書き出さない。

# en

## headline

Turns the export of merged pull requests into draft user-facing release notes, grouped by type, as a Word document.

## audience

Software product managers, and development team leads who put each release together

## problem

At every release, someone goes back over the list of pull requests, picks out the changes that matter to users and rewrites them by type. Developer-only changes slip in, and effects the list never states get added.

## steps

1. [] Receive: takes the export of the pull requests merged for the release.
2. [] Look up: reads your release notes style guide and separates what is listed from what is not.
3. [] Decide: shows the outline in its reply, compatibility, security, new features and bug fixes in that order, each item with its pull request number.
4. [] A person confirms: waits for approval before writing the Word file.
5. [] Write: writes the release notes as a Word file in the one approved call.

## outputs

- A release notes outline in the reply: the items of each group with the number of the pull request each comes from
- The release notes as a Word file (.docx), written once it is approved
- The pull requests left out and why, and open points such as the release date

## faq

### Will it list changes the export does not contain?

No. It lists only the pull requests in the export, and adds no effect or plan that their titles and descriptions do not state.

### What happens to developer-only changes?

Changes whose label the style guide leaves out stay out of the document, and the reply lists them with the reason.

### Can it follow our own style?

The style guide is a file in your own folder. Change its groups or order and the outline follows it.

## limits

- Never publishes the release notes or sends them to users.
- Never lists a change, an effect or a plan that the export does not contain.
- Does not review or merge code.
- Does not write Markdown or web pages.
