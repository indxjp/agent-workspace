# ja

## headline

IT資産台帳と端末管理ツールの検出結果を突き合わせ、台帳と実態の差とライセンスの過不足を、計算どおりの数値とグラフで示す。

## audience

情報システム部門・総務部門の資産管理の担当者

## problem

棚卸のたびに、資産台帳と端末管理ツールの一覧を表計算ソフトで並べ、シリアル番号を一つずつ照らし合わせている。見つからない端末、台帳にない端末、廃棄したはずの端末の接続や、ライセンスの導入数の超過は見落としやすく、照合だけで手間がかかる。

## steps

1. [] 受け取る：資産台帳のCSVと、端末管理ツールから書き出した検出結果のCSVを受け取る。
2. [] 調べる：台帳のPCと検出された端末を、シリアル番号で照らし合わせる。
3. [] 判断する：決まった規則で動くスクリプトが、検出されない端末、台帳にない端末、廃棄済みなのに検出された端末、利用者の違い、しばらく接続のない端末と、ライセンスの保有数と導入数の差を求める。
4. [] 人が確認する：台帳や端末をどう直すかは、担当者が決める。
5. [] 書き込む：台帳にも端末にも書き込まず、結果を表とグラフで返す。

## outputs

- 差の種類ごとの一覧：資産番号、シリアル番号、ホスト名、利用者、最終接続日
- ライセンスごとの保有数・導入数・過不足
- ライセンスの過不足の棒グラフ

## faq

### 端末をロックしたり、台帳を直したりしてくれますか？

いいえ。照らし合わせた結果を示すだけで、台帳の書き換え、端末のロックや初期化、ライセンスの割り当ては行いません。どう直すかは担当者が決めます。

### しばらく接続のない端末は何日で判断しますか？

検出結果の最新の日付から決まった日数より前に最後に接続した、使用中の端末を挙げます。依頼の中で日数を指定すると、その基準で判断します。

### ライセンスの導入数はどう数えますか？

検出された端末のうち、そのソフトが入っている端末を1台につき1回数えます。台帳の数量を合計した保有数と比べ、差を示します。

### どんな形式のデータを読めますか？

資産番号・区分・品名・シリアル番号・数量・利用者・状態の列がある台帳と、シリアル番号・ホスト名・利用者・最終接続日・インストール済みソフトの列がある検出結果を、CSV（UTF-8）かExcelのファイル（.xlsx、最初のシート）で読みます。列名は日本語と英語のどちらでも構いません。

## limits

- 台帳を書き換えたり、端末をロック・初期化したり、ライセンスを割り当てたりしない。
- 端末が見つからない理由や、誰の責任かを推測しない。
- 台帳や検出結果を保存したり送ったりしない。
- 読めない値（空欄、数値でない数量、知らない区分や状態、シリアル番号のないPCなど）があれば推測せず、計算せずにその行を伝える。

# en

## headline

Matches your IT asset register against the device-management inventory, and shows the gaps between the register and reality and the licence shortfalls and surpluses with exactly the computed numbers and a chart.

## audience

IT and general affairs staff who manage company assets

## problem

At every stocktake, someone lines up the asset register and the device-management list in a spreadsheet and checks the serial numbers one by one. Missing devices, devices missing from the register, disposed devices that still connect and licences installed beyond what was bought are easy to miss, and the matching alone takes effort.

## steps

1. [] Receive: takes the asset register CSV and the inventory CSV that your device-management tool exports.
2. [] Look up: matches the register's PCs with the detected devices by serial number.
3. [] Decide: a script that works by fixed rules finds the PCs not detected, the devices not in the register, the disposed PCs still detected, the user mismatches, the PCs not seen for a while, and each licence's seats owned against its installs.
4. [] A person confirms: a person decides how to correct the register and the devices.
5. [] Write: writes nothing to the register or a device, and returns the result as tables and a chart.

## outputs

- A list per kind of gap: asset id, serial number, host name, user and last seen date
- Each licence's seats owned, installs and the gap
- A bar chart of the licence gaps

## faq

### Will it lock a device or fix the register?

No. It shows the result of the match only. It never changes the register, locks or wipes a device, or assigns a licence; a person decides what to correct.

### How many days without a connection counts as not seen recently?

It lists PCs in use whose last connection was more than a set number of days before the inventory's latest date. Name a number of days in your request and it uses that.

### How does it count licence installs?

It counts each detected device that has the software installed once, and compares that with the seats owned, the register's quantities added up.

### What data can it read?

A register with columns for the asset id, kind, product, serial number, quantity, user and status, and an inventory with the serial number, host name, user, last seen date and installed software, each as a CSV (UTF-8) or an Excel file (.xlsx, its first sheet), with the columns named in Japanese or English.

## limits

- Never changes the register, locks or wipes a device, or assigns a licence.
- Never guesses why a device is missing or who is at fault.
- Never saves or sends the register or the inventory.
- Never guesses a value it cannot read (an empty cell, a quantity that is not a number, an unknown kind or status, a PC with no serial number): it computes nothing and names the row.
