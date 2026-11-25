# ja

## headline

問い合わせや展示会のリードを決まった配点で点数にし、先に連絡すべき順を点数の内訳とともに示す。

## audience

営業・インサイドセールスの担当者、リードの振り分けを決める営業マネージャー

## problem

問い合わせフォーム、展示会、ウェビナー、資料請求から集まったリードを、担当者が表計算ソフトで並べ替え、どこから連絡するかを経験で決めている。基準が人によって違い、なぜその順なのかを後から説明しにくい。

## steps

1. [] 受け取る：CRMやマーケティングツールから書き出した、リードごとの流入元・会社規模・訪問数・最終接触日のCSVを受け取る。
2. [] 調べる：指定されたファイルの各リードを読み取る。依頼があれば流入元を絞る。
3. [] 判断する：決まった計算をするスクリプトが、流入元・会社規模・訪問数・接触の近さの配点を足して点数を求め、点数の順に並べる。
4. [] 人が確認する：連絡する順と点数の内訳を、営業担当者が確かめて連絡先を決める。
5. [] 書き込む：ファイルは書き込まず、結果を表とコメントで返す。

## outputs

- 連絡する順に並べたリードの一覧：順位、リードID、会社名、流入元、点数と、その内訳
- リードの点数の棒グラフと、流入元ごとの平均点の棒グラフ
- スクリプトが出した数値だけを引用したコメント

## faq

### 人を評価しますか？

いいえ。順位を付けるのはリード（会社からの引き合い）だけです。営業担当者や先方の担当者を点数にしたり順位を付けたりする依頼は断ります。

### 点数はどう決まりますか？

流入元、会社の従業員数、ウェブサイトへの直近の訪問数、最後に接触してからの日数に、決まった配点があります。決まった計算をするスクリプトがその合計を求め、AIは結果を読んで説明するだけです。

### 自社のCRMの書き出しを使えますか？

リードID・会社名・業種・流入元・従業員数・訪問数・最終接触日の列があるCSV（UTF-8）か、Excelのファイル（.xlsx、最初のシート）を読みます。列名は日本語と英語のどちらでも構いません。

## limits

- 人（営業担当者や先方の担当者）を点数にしたり、順位を付けたりしない。
- 会社が買うかどうかや、その理由を推測しない。
- メールの送信やCRMへの登録、ファイルの書き換えはしない。
- 読めない値（空欄、整数でない数、知らない流入元など）があれば推測せず、計算せずにその行と列を伝える。

# en

## headline

Scores enquiry and event leads by fixed points, and shows the order to contact them with what makes up each score.

## audience

Sales and inside-sales staff, and sales managers who decide how leads are assigned

## problem

Leads arrive from the contact form, trade shows, webinars and downloads. Someone sorts them in a spreadsheet and decides from experience whom to contact first. Each person uses a different yardstick, and the order is hard to explain afterwards.

## steps

1. [] Receive: takes the CSV your CRM or marketing tool exports, with each lead's source, company size, web visits and last contact date.
2. [] Look up: reads each lead in the file named, narrowed to one source when asked.
3. [] Decide: a script that computes by fixed rules adds up the points for source, company size, visits and recency, and puts the leads in order of score.
4. [] A person confirms: a salesperson checks the order and the points behind each score, and decides whom to contact.
5. [] Write: writes no file, and returns the result as a table and commentary.

## outputs

- The leads in the order to contact them: rank, lead id, company, source, score and the points that make it up
- A bar chart of the lead scores, and a bar chart of the average score by source
- Commentary that quotes only numbers the script printed

## faq

### Does it rate people?

No. It ranks leads, that is companies' enquiries, and nothing else. It declines any request to score or rank a salesperson or a contact at a company.

### How is the score decided?

Fixed points for the source, the company's headcount, its recent visits to your website and the days since the last contact. A script that computes by fixed rules adds them up; the AI reads its result and explains it.

### Can it read our CRM's export?

It reads a CSV (UTF-8) or an Excel file (.xlsx, its first sheet) with columns for the lead id, company, industry, source, employees, visits and last contact date, named in Japanese or English.

## limits

- Never scores or ranks a person, neither a salesperson nor a contact at a company.
- Never guesses whether or why a company will buy.
- Never sends email, records anything in the CRM, or changes a file.
- Never guesses a value it cannot read (an empty cell, a count that is not whole, an unknown source): it computes nothing and names the row and column.
