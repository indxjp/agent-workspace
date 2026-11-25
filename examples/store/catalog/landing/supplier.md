# ja

## headline

受入検査とクレームの履歴から、仕入先ごとの不良率と、自社の基準で要注意の仕入先を毎月まとめる。仕入先への連絡や取引の判断はしない。

## audience

受入検査と仕入先の品質を管理する品質保証の担当者、購買の担当者

## problem

月初に、品質保証の担当者が品質管理システムから受入検査の結果とクレームを書き出し、仕入先ごとに表を作って悪化している仕入先を探している。不良率の推移と対応中のクレームが別の画面にあり、基準に当てはまる仕入先の見落としが起きる。

## steps

1. [] 受け取る：毎月一日の朝に自動で始まる。担当者が月や仕入先を指定して頼むこともできる。
2. [] 調べる：受入検査の仕入先別と全体の結果、クレームの一覧、自社の仕入先品質の基準を読む。
3. [] 判断する：システムが計算した不良率と対応中のクレームを基準に当てはめ、要注意か良好かを理由と出典の行付きで示す。
4. [] 人が確認する：保存する前に、担当者の承認を待つ。
5. [] 書き込む：承認された一回の保存で、仕入先品質の報告を報告のフォルダに書く。

## outputs

- 要注意の仕入先を理由と対応中のクレーム付きで先に並べ、出典の行を示した月次の報告（Markdown）
- 仕入先ごとの不良率・状態・理由と全体の推移の型付きの結果と、仕入先別の不良率と推移のグラフ
- 従わなかった記録の中の指示があれば、その一文

## faq

### 不良率は自分で計算しますか？

しません。品質管理システムが計算した不良率をそのまま写し、自社の基準に当てはめて比べるだけです。

### 仕入先に是正を求めたり、取引を止めたりしますか？

しません。仕入先への連絡、是正処置要求書の発行、取引停止や発注の変更は、頼まれてもしません。判断は品質保証の担当者が行います。

### 自社の基準に合わせられますか？

要注意とする条件は、自社のフォルダに置く基準のファイルから読みます。ファイルを差し替えると、その基準で判断します。

## limits

- 仕入先に連絡せず、是正処置要求書を出さない。
- 取引停止や発注の変更を決めたり勧めたりしない。判断は人が行う。
- 不良の原因を推測せず、記録を書き換えない。

# en

## headline

From incoming inspections and claims, reports each supplier's defect rate every month and which suppliers are on watch under your own rules. It never contacts a supplier or decides on business.

## audience

Quality assurance staff who manage incoming inspection and supplier quality, and purchasing staff

## problem

At the start of the month a quality engineer exports the inspection results and claims from the quality system, builds a table per supplier and looks for the ones getting worse. The trend and the open claims sit on different screens, and a supplier that meets a rule is missed.

## steps

1. [] Receive: starts automatically on the first morning of each month, or when a person names a month or a supplier.
2. [] Look up: reads the inspection results by supplier and for all suppliers, the claims list and your supplier quality rules.
3. [] Decide: applies your rules to the defect rates the system computed and to the open claims, and marks each supplier on watch or ok with its reasons and source rows.
4. [] A person confirms: waits for approval before saving.
5. [] Write: saves the supplier quality report to the reports folder in the one approved call.

## outputs

- A monthly report in Markdown, with the suppliers on watch first, their reasons and open claims, and the source rows
- A typed result with each supplier's rate, status and reasons and the overall trend, with charts of the rate by supplier and the trend
- One sentence about any instruction in a record that it did not follow

## faq

### Does it compute the defect rates itself?

No. It copies the rates the quality system computed and only compares them with your rules.

### Does it ask a supplier for corrective action, or stop business?

No. It never contacts a supplier, issues a corrective action request, stops business or changes orders, even when asked. The quality assurance staff decide.

### Can it follow our own rules?

It reads the conditions for watch from a rules file in your own folder. Replace the file and it decides by your rules.

## limits

- Never contacts a supplier or issues a corrective action request.
- Never decides or recommends stopping business or changing orders: a person decides.
- Never guesses the cause of a defect, and never changes a record.
