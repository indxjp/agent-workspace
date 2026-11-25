# ja

## headline

技術メモの構成要素ごとに近い先行特許を探し、公報番号と公開日の出典と、どの時点の公報かを添えて比較表にする。

## audience

開発や生産技術の技術者、出願や他社の特許を調べる知的財産部の担当者

## problem

新しい装置を考えるたびに、技術者が言葉を変えながら特許公報を検索し、近いものを読み比べて表にまとめている。どの公報がメモのどの構成に当たるのか、いつ時点の検索なのかが、資料から抜けやすい。

## steps

1. [] 受け取る：技術メモ、または特許公報についての質問を受け取る。
2. [] 調べる：社内のフォルダで技術メモを探して構成要素を読み、構成要素ごとの言葉で特許公報を検索する。
3. [] 判断する：公報の名称と要約に書かれた構成だけを比較表に示す。特許性や侵害の判断はしない。
4. [] あなたが確かめる：公報ごとに公報番号と公開日の出典が付くので、元の公報を開いて自分で確かめられる。法的な判断は弁理士が行う。
5. [] 書き込む：何も書き込まない。比較表と出典を付けた回答を、依頼した人に返すだけである。

## outputs

- 結論と、構成要素ごとの比較表（公報番号・出願人・公開日・状態つき）
- 回答がどの時点の特許公報に基づくかを示す一文
- 回答・時点・出典・比較の型付きの結果

## faq

### 特許を取れるか、他社の特許を侵害しないかを判断できますか？

しません。新規性・特許性・侵害・有効性の判断は弁理士にご相談くださいと伝え、近い公報を出典つきで示すところまでを行います。

### どの時点の公報を使いますか？

デモでは、架空の特許公報の日付つきスナップショット（2026-11-16 時点）を読み、回答にその日付を示します。特許庁などの提供元を読む設定には、利用の申請と鍵が要るため、まだ対応していません。

### 自社の技術メモの書き方に合わせられますか？

構成要素と調べるときの言葉を書いた技術メモを、自社のフォルダに置きます。その構成要素ごとに比較表を作ります。

## limits

- 新規性・特許性・侵害・有効性を判断しない。
- 公報に書かれていない構成や請求の範囲を推測しない。
- 社内のファイルを書き換えたり、他社に連絡したりしない。

# en

## headline

Finds the prior patents closest to a technical memo, element by element, and compares them in a table citing each publication's number and date and the date the publications stand as of.

## audience

Development and production engineers, and IP staff who look into filings and other companies' patents

## problem

Each time a new device is designed, engineers search patent publications with one phrasing after another, read the close ones side by side and type up a table. Which publication matches which element of the memo, and the date the search stands as of, easily go missing from the result.

## steps

1. [] Receive: takes a technical memo, or a question about patent publications.
2. [] Look up: finds the technical memo in your folder, reads its elements, and searches the patent publications with words for each element.
3. [] Decide: shows in the table only what a publication's title and abstract state. It never judges patentability or infringement.
4. [] You check the cited publication: every publication is cited by number and date, so you can open it and check. A patent attorney makes any legal judgement.
5. [] Write: writes nothing; it only returns the table and its citations to the person asking.

## outputs

- An answer with the conclusion first and a table by element (publication number, applicant, publication date and status)
- A line saying the date the patent publications stand as of
- A typed result with the answer, the date, the citations and the comparison

## faq

### Can it tell us whether we can get a patent, or whether we infringe one?

No. It says to ask a patent attorney about novelty, patentability, infringement or validity, and gives the closest publications with their citations.

### What date are the publications from?

In the demo, it reads a dated snapshot of fictional patent publications (as of 2026-11-16) and says that date in every answer. Reading a patent office's data needs an access application and a key, which it does not support yet.

### Can it follow the way we write technical memos?

Put a technical memo listing the elements and the words to search for in your folder. It builds the table element by element from that memo.

## limits

- Does not judge novelty, patentability, infringement or validity.
- Does not guess at an element or a claim a publication does not state.
- Does not change your files or contact other companies.
