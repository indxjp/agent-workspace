# ja

## headline

取引先の登録申請にある会社・役員・株主・最終需要者の名前を公開リストと照合し、一致の候補をリストの日付つきで担当者に示す。取引の可否は判断しない。

## audience

新規の取引先を登録する調達・営業の担当者、取引先の確認を担う法務・輸出管理の担当者

## problem

新しい取引先を登録するたびに、申請書の名前を一つずつ公開リストで検索している。カタカナとローマ字の表記ゆれや、似た名前の別の会社を見落としやすく、どの日付のリストで確かめたかの記録も残りにくい。

## steps

1. [] 受け取る：取引先の登録申請書を受け取る。
2. [] 調べる：社内の確認手順を読み、申請書のすべての名前を、表記を変えながら公開リストで検索する。
3. [] 判断する：手順の項目ごとに、一致なし・要確認・一致を、リストの記録と日付付きで回答に示す。取引の可否は判断しない。
4. [] 人が確認する：報告書を保存する前に、担当者の承認を待つ。
5. [] 書き込む：承認された一回の保存で、照合の報告書を報告のフォルダに書く。

## outputs

- 手順の項目ごとの照合結果と、該当したリストの記録・確認すべき点を並べた表（回答の中に表示）
- 承認のあと保存される、照合したリストの日付つきの報告書（Markdown）
- 項目ごとの型付きの照合結果

## faq

### 取引してよいかを判断しますか？

しません。取引してよいか、問題がないかは、頼まれても答えません。似た名前は別の相手だと決めつけず要確認として示し、判断は担当者が行います。

### どの時点のリストと照合しますか？

デモでは、架空の公開リストの日付つきスナップショット（2026-11-16 時点）と照合し、結果にその日付を示します。導入するときは、自社で使う公開リストの配布先を設定して、最新のリストを読みます。

### 自社の確認手順に合わせられますか？

確認手順は自社のフォルダに置くファイルです。差し替えると、その項目ごとに照合します。

## limits

- 取引してよいか、相手が安全かを判断せず、法的助言もしない。判断は担当者が行う。
- 読んだリストとその日付の範囲を超えて「掲載なし」と言わない。
- 申請書や確認手順を書き換えない。
- 取引先に連絡したり、個人の情報を調べたりしない。

# en

## headline

Checks every company and person in a counterparty registration request (the company, officers, shareholders and end user) against public lists, and flags possible matches for a person with the date of the lists. It never decides whether to do business.

## audience

Procurement and sales staff who register new counterparties, and the legal and export control staff who screen them

## problem

For every new counterparty, someone searches the public lists by hand, one name of the request at a time. Variant spellings in katakana and romaji, or a similar name of a different company, are easy to miss, and which date of the lists was checked is rarely recorded.

## steps

1. [] Receive: takes the counterparty registration request.
2. [] Look up: reads your screening procedure and searches the public lists for every name in the request, spelled several ways.
3. [] Decide: shows in its reply no match, review or match for each item of the procedure, with the listed record and the date of the lists. It never decides whether to do business.
4. [] A person confirms: waits for approval before saving the report.
5. [] Write: saves the screening report to the reports folder in the one approved call.

## outputs

- A table in the reply: each item's result, the listed record found and what to confirm
- The screening report in Markdown, with the date of the lists checked, saved once it is approved
- A typed result for each item

## faq

### Does it decide whether we can do business with the party?

No. It never says whether to do business or that a party is cleared, even when asked. A similar name is flagged for review, never dismissed as someone else, and a person decides.

### Which date of the lists does it check?

The demo checks a dated snapshot of fictional public lists (as of 2026-11-16) and shows that date with every result. When you install it, you set the addresses of the public lists you use, and it reads the current lists.

### Can it use our own screening procedure?

The procedure is a file in your own folder. Replace it and it screens against its items.

## limits

- Never says whether to do business or that a party is safe, and gives no legal advice: a person decides.
- Never says a name is on no list beyond the lists and the date it read.
- Never changes the request or the procedure.
- Never contacts the counterparty or looks up someone's personal details.
