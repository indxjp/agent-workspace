# ja

## headline

社員サーベイの結果を、一定の人数以上の部署ごとに集計し、低い項目と前回からの変化をグラフで示して、部署で話し合う打ち手の案を添える。

## audience

人事・組織開発の担当者、自部署の結果を受け取る部門長

## problem

人事の担当者がサーベイツールから結果を書き出し、部署ごとに好意的な回答の割合を計算し、前回の結果と並べて下がった項目を探している。人数の少ない部署では回答した人が分かってしまうおそれがあり、部署ごとの資料づくりにも手間がかかる。

## steps

1. [] 受け取る：サーベイツールから書き出した、実施回・部署・設問ごとの評価のCSVと、比べるときは前回のCSVを受け取る。
2. [] 調べる：部署ごとの回答者の数を確かめ、一定の人数に満たない部署を見つける。
3. [] 判断する：決まった計算をするスクリプトが、一定の人数以上の部署だけで、部署別・設問別の好意的な回答の割合と前回からの変化を求め、大きく下がった項目に印を付ける。人数の少ない部署はどの数値にも含めずに伏せる。
4. [] 人が確認する：部署別と設問別のグラフ、下がった項目と打ち手の案を、担当者と部門長が確かめる。
5. [] 書き込む：ファイルは書き込まず、結果を表とコメントで返す。

## outputs

- 部署別・設問別の好意的な回答の割合と、前回からの変化
- 部署別と設問別の好意的な回答の割合の棒グラフ
- 下がった項目や低い項目と、部署で話し合う打ち手の案、人数が少なく伏せた部署の名前

## faq

### 回答した人が分かってしまいませんか？

スクリプトは回答IDもコメントも出さず、一定の人数以上の部署だけを集計します。人数の少ない部署は名前だけを示し、その回答は全社の数値にも含めません。誰がどう答えたかを探す依頼には応じません。

### 社員や上司を評価するのですか？

いいえ。結果は部署単位で示すだけで、個人の順位付けや評価、人事上の判断はしません。打ち手は部署で話し合うための案で、決めるのは部署と部門長です。

### 前回の結果と比べられますか？

依頼の中で前回のファイルを伝えると、項目ごとの変化を求め、大きく下がった項目を挙げます。下がったとみなす幅も依頼の中で変えられます。

## limits

- 回答者を特定したり、社員や上司を順位付け・評価したりしない。
- 人数の少ない部署の数値は示さず、コメントも引用しない。
- 低い項目の原因を推測せず、集計できる数値だけを示す。
- サーベイのファイルを書き換えたり、保存したり、送ったりしない。

# en

## headline

Tallies an engagement survey for each team large enough to keep answers anonymous, shows the low items and the change since the last survey in charts, and adds actions for the team to discuss.

## audience

HR and organisation development staff, and department heads who receive their team's results

## problem

An HR officer exports the results from the survey tool, works out each team's favourable share, and sets them beside the last survey to find what dropped. In a small team the answers can point to individuals, and preparing each team's pack takes time.

## steps

1. [] Receive: takes the CSV your survey tool exports, with the round, team and each question's rating, and the earlier round's CSV when comparing.
2. [] Look up: checks how many respondents each team has, and finds the teams below the minimum size.
3. [] Decide: a script that computes by fixed rules works out, over the teams large enough only, the favourable share by team and by question and its change since the last survey, and flags the items that fell sharply. A small team is held back and left out of every figure.
4. [] A person confirms: HR and the department heads check the charts by team and by question, the items that dropped and the suggested actions.
5. [] Write: writes no file, and returns the result as a table and commentary.

## outputs

- The favourable share by team and by question, with the change since the last survey
- Bar charts of the favourable share by team and by question
- The items that dropped or are lowest, with actions for the team to discuss, and the names of the teams held back for being too small

## faq

### Could someone tell who answered?

The script prints no response ID or comment, and tallies only the teams with enough respondents. A small team is named and left out of every figure, the company's included. It does not help find how anyone answered.

### Does it assess employees or managers?

No. It shows results by team only, and never ranks, scores or judges a person or makes an HR decision. The actions are ideas for the team to discuss; the team and its manager decide.

### Can it compare with the last survey?

Name the earlier file in your request and it works out each item's change and lists the items that fell sharply. You can also name how large a fall to list.

## limits

- Never identifies a respondent, and never ranks or judges an employee or a manager.
- Never shows figures for a team too small to keep answers anonymous, and never quotes a comment.
- Never guesses why an item is low; shows only the figures it can compute.
- Never changes, saves or sends the survey files.
