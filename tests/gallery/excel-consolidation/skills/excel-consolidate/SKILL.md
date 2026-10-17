---
name: excel-consolidate
description: 拠点ごとにレイアウトの違う売上 Excel を、確認済みのマッピング計画に従って1つの表に集約し、前月比を計算する。すべての値に「ファイル!シート!セル」の出典が残る。
---

# 拠点別売上の集約

Excel は先に `office-reader` スキルで JSON にする。スクリプトは作業ディレクトリからの相対パス
`.claude/skills/<スキル名>/scripts/…` で呼ぶ（`cd` しない）。`find_files` が返した **`localPath`**（絶対パス）を渡す。
`path` は作業ディレクトリからは開けない。`localPath` は作業ディレクトリの外にあり、`run_skill_script` からは
読めないので、Bash で `node` を実行する。出力は、ファイル名（`path` の最後の部分）に `.json` を足した名前で保存する。
ファイルごとにコマンドを分けず、全ファイルを1回のループで JSON にする。

```sh
for f in "<localPath 1>" "<localPath 2>" …; do
  node .claude/skills/office-reader/scripts/ooxml.mjs xlsx "$f" > "${TMPDIR:-/tmp}/$(basename "$f").json"
done
```

## 1. シートを調べる

```sh
node .claude/skills/excel-consolidate/scripts/consolidate.mjs inspect "${TMPDIR:-/tmp}"/*.xlsx.json
```

全ファイルをまとめて渡す（1回で足りる）。ファイルごとに、各シートの先頭8行を行番号と列記号
（A, B, …）つきで出す。ここから見出し行・列・日付の書き方を読む。

各シートには `unit`（`円` / `千円` / `百万円` / `null`）と、その根拠のセル `unitFrom`（例: `D4 金額(千円)`、
`A2 単位:円`）が付く。見出しの「金額（千円）」と、見出しの外の「単位：円」の行のどちらも拾う。
計画の `unit` はこの値をそのまま使う。`null` のシート（表紙など）は、データのあるシートだけを見る。

## 2. マッピング計画を書く（まだ集計しない）

```json
{
  "from": "2025-04",
  "to": "2025-05",
  "layouts": [
    {
      "branch": "東京",
      "files": ["東京支店/東京_売上報告_2025年4月.xlsx", "東京支店/東京_売上報告_2025年5月.xlsx"],
      "sheet": "売上明細",
      "headerRows": [3, 4],
      "columns": { "date": "A", "category": "B", "amount": "D" },
      "unit": "千円",
      "dateFormat": "wareki",
      "skip": ["小計", "※"]
    }
  ],
  "excluded": [{ "file": "共通/売上報告テンプレート.xlsx", "reason": "データ行がない" }]
}
```

- `files` は `find_files` が返した `path`（相対パス）をそのまま書く。`localPath` は書かない。見つけたファイルは、`layouts` か `excluded`（理由つき）のどちらかに必ず入れる。
- 同じ拠点でも、月によってシート名が違えば `layouts` を分ける。
- `headerRows` は1始まりの行番号。データは最後の見出し行の次の行から。
- `columns` は `date`（日付）・`category`（区分）・`amount`（金額）の3つすべて。
- `unit` は `円` / `千円` / `百万円` のどれかを必ず書く。`inspect` の `unit` を使い、`null` なら「単位：千円」のような行を探す。見つからなければ推測せず、計画の説明で利用者に確認する。計画の説明には、拠点ごとの単位（例: 東京 千円）を必ず書く。
- `dateFormat` は `wareki`（令和7年5月8日・R7.5.8・平成）/ `ymd`（2025/05/08）/ `serial`（Excel のシリアル値）。
- `skip` は日付列か区分列がその文字で始まる行を除く（小計・合計・注記）。

計画を出したら、そこで止めて利用者の確認を待つ。

## 3. 確認後に集計する

```sh
T="${TMPDIR:-/tmp}"
node .claude/skills/excel-consolidate/scripts/consolidate.mjs apply plan.json "$T"/*.xlsx.json > "$T/applied.json"
node .claude/skills/excel-consolidate/scripts/consolidate.mjs compare "$T/applied.json" 2025-04 2025-05 > "$T/report.json"
```

- 見出しの単位が計画と食い違うと、スクリプトは止まる（終了コード1）。単位を直した計画を利用者に再確認する。
- `skipped` に出た行（小計・注記・数値でない金額）は、件数と理由を説明に書く。

## 4. 説明を書く

- 数字は `report.json` にあるものだけを、スクリプトの出力どおり（円、3桁区切り、％は小数1桁）に書く。暗算した合計や差額を書かない。
- 増減の大きい拠点から順に、どの行（`@src`）が効いているかを示す。
- 最後に `report.json` の中身を ```json のコードブロックでそのまま付ける。
