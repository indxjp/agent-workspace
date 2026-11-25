# ja

## headline

顧客アンケートの回答を、回答者を特定しないまとまりだけで集計し、設問ごとの評価と窓口別の違いをグラフと計算どおりの数値で示す。

## audience

カスタマーサポートの責任者、顧客満足度の調査を担当する品質管理・企画の担当者

## problem

アンケートツールから回答を書き出し、担当者が表計算ソフトで設問ごとの平均や推奨度を計算し、自由記述を読み込んで要点をまとめている。窓口ごとに比べようとすると回答の少ない窓口で個人が分かってしまうおそれがあり、集計のたびに計算式のずれも起きやすい。

## steps

1. [] 受け取る：アンケートツールから書き出した、回答日・窓口・評価・推奨度・自由記述のCSVを受け取る。
2. [] 調べる：依頼された月の回答を読み取り、窓口ごとに回答の数を確かめる。
3. [] 判断する：決まった計算をするスクリプトが、回答が一定数以上ある窓口だけで、設問ごとの平均と好意的な回答の割合、NPS、窓口別の数値を求め、少なすぎる窓口はどの数値にも含めずに伏せる。
4. [] 人が確認する：設問別と窓口別のグラフ、自由記述の傾向を、担当者が確かめる。
5. [] 書き込む：回答者への連絡もファイルの書き込みもせず、結果を表とコメントで返す。

## outputs

- 設問ごとの平均と好意的な回答の割合、NPS（推奨者・中立者・批判者の数）
- 設問別の好意的な回答の割合と、窓口別の総合満足度の棒グラフ
- 自由記述の傾向を言葉でまとめたコメントと、回答が少なく伏せた窓口の名前

## faq

### 回答した人が誰か分かってしまいませんか？

スクリプトは回答IDや回答日を出さず、回答が一定数以上ある窓口だけを集計します。少なすぎる窓口は名前だけを示し、その回答はどの数値にも含めません。特定の回答者を探す依頼には応じません。

### 数値をAIが計算するのですか？

いいえ。平均・割合・NPSは、決まった計算をするスクリプトが求めます。AIはその結果を読んで説明するだけで、スクリプトが出していない数値は書かず、自由記述の件数も自分で数えません。

### 自社のアンケートツールの書き出しを使えますか？

回答日・窓口・総合満足度・対応の速さ・説明のわかりやすさ・推奨度・自由記述の列があるCSV（UTF-8）か、Excelのファイル（.xlsx、最初のシート）を読みます。列名は日本語と英語のどちらでも構いません。

### 集計する月は選べますか？

依頼の中で月を伝えると、その月の回答を集計します。伝えないときは、ファイルにある最後の月を集計します。

## limits

- 回答者を特定したり、個々の回答者を評価したりしない。回答が少なすぎるまとまりの数値は示さない。
- 回答者への返信やお礼の連絡をしない。
- 低い評価の原因を推測せず、集計できる数値と自由記述の傾向だけを示す。
- アンケートのファイルを書き換えたり、保存したり、送ったりしない。

# en

## headline

Tallies customer survey responses only in groups too large to identify anyone, and shows each question's rating and the differences between channels with charts and exactly the computed numbers.

## audience

Customer support leads, and quality or planning staff who run customer satisfaction surveys

## problem

Someone exports the responses from the survey tool, works out each question's average and the recommend score in a spreadsheet, and reads through the comments to sum them up. Comparing channels risks pointing to individuals where a channel has few responses, and formulas drift from one survey to the next.

## steps

1. [] Receive: takes the CSV your survey tool exports, with the date, channel, ratings, recommend score and comment of each response.
2. [] Look up: reads the responses of the month asked for, and checks how many each channel has.
3. [] Decide: a script that computes by fixed rules works out, over the channels with enough responses only, each question's average and favourable share, the Net Promoter Score and the figures per channel, and holds back a channel with too few, leaving it out of every figure.
4. [] A person confirms: a person checks the charts by question and by channel, and the themes of the comments.
5. [] Write: contacts no respondent and writes no file, and returns the result as a table and commentary.

## outputs

- Each question's average and favourable share, and the Net Promoter Score with its promoters, passives and detractors
- Bar charts of the favourable share by question and of overall satisfaction by channel
- Commentary on the themes of the comments in words, naming the channels held back for having too few responses

## faq

### Could someone tell who answered?

The script prints no response ID or date, and tallies only the channels with enough responses. A channel with too few is named and left out of every figure. It does not help find a particular respondent.

### Does the AI do the arithmetic?

No. A script that computes by fixed rules works out the averages, the shares and the Net Promoter Score. The AI reads its result and explains it, never writes a number the script did not print, and does not count comments itself.

### Can it read our survey tool's export?

It reads a CSV (UTF-8) or an Excel file (.xlsx, its first sheet) with columns for the date, channel, overall satisfaction, speed, clarity, recommend score and comment, named in Japanese or English.

### Can I choose the month?

Name a month in your request and it tallies that month's responses. Otherwise it tallies the last month in the file.

## limits

- Never identifies or judges a respondent, and never shows figures for a group too small to keep anyone anonymous.
- Never replies to or thanks respondents.
- Never guesses why a rating is low; shows only the figures it can compute and the themes of the comments.
- Never changes, saves or sends the survey files.
