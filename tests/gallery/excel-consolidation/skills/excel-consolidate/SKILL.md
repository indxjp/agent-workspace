---
name: excel-consolidate
description: 拠点ごとにレイアウトの違う売上 Excel を、確認済みのマッピング計画に従って1つの表に集約し、前月比を計算する。すべての値に「ファイル!シート!セル」の出典が残る。
---

# 拠点別売上の集約

スクリプトは `run_skill_script` ツール（`skill`・`script`・`args`）で動かす。パイプ・
リダイレクト・ワイルドカードは使えない。Excel はスクリプトが直接読むので、事前の変換は要らない。
Excel の引数には、`search_files` が返した **`path`**（作業ディレクトリからの相対パス）をそのまま並べる。
読めるのは作業ディレクトリの中だけで、書けるのは `outputs` だけ。結果を次の呼び出しに渡すときは
`--out outputs/…` を付ける（結果は標準出力にも出る）。

## 1. シートを調べる

```json
{
  "skill": "excel-consolidate",
  "script": "consolidate.mjs",
  "args": ["inspect", "<path 1>", "<path 2>", "…"]
}
```

全ファイルをまとめて渡す（1回で足りる）。ファイルごとに、各シートの先頭8行を行番号と列記号
（A, B, …）つきで出す。ここから見出し行・列・日付の書き方を読む。

各シートには `unit`（`円` / `千円` / `百万円` / `null`）と、その根拠のセル `unitFrom`（例: `D4 金額(千円)`、
`A2 単位:円`）が付く。見出しの「金額（千円）」と、見出しの外の「単位：円」の行のどちらも拾う。
計画の `unit` はこの値をそのまま使う。`null` のシート（表紙など）は、データのあるシートだけを見る。

## 2. マッピング計画を書く（まだ集計しない）

計画は `Write` で `outputs/plan.json` に書く。中身は次の形の JSON だけ。`Write` は利用者が承認するまで
実行されない。

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

- `files` は `search_files` が返した `path`（相対パス）をそのまま書く。見つけたファイルは、`layouts` か `excluded`（理由つき）のどちらかに必ず入れる。
- 同じ拠点でも、月によってシート名が違えば `layouts` を分ける。
- `headerRows` は1始まりの行番号。データは最後の見出し行の次の行から。
- `columns` は `date`（日付）・`category`（区分）・`amount`（金額）の3つすべて。
- `unit` は `円` / `千円` / `百万円` のどれかを必ず書く。`inspect` の `unit` を使い、`null` なら「単位：千円」のような行を探す。見つからなければ推測せず、計画の説明で利用者に確認する。計画の説明には、拠点ごとの単位（例: 東京 千円）を必ず書く。
- `dateFormat` は `wareki`（令和7年5月8日・R7.5.8・平成）/ `ymd`（2025/05/08）/ `serial`（Excel のシリアル値）。
- `skip` は日付列か区分列がその文字で始まる行を除く（小計・合計・注記）。

計画を `Write` したら、承認が出るまで進まない。拒否されたら、理由に沿って計画を直し、もう一度
`outputs/plan.json` に `Write` する。

## 3. 承認後に集計する

承認された計画は `outputs/plan.json` にある（承認後に同じ内容でもう一度 `Write` する）。そのあと `apply` と `compare` を呼ぶ。
`apply` の Excel の引数は、計画の `files` にあるファイルすべて（名前で突き合わせる）:

```json
{
  "skill": "excel-consolidate",
  "script": "consolidate.mjs",
  "args": [
    "apply",
    "outputs/plan.json",
    "<path 1>",
    "<path 2>",
    "…",
    "--out",
    "outputs/applied.json"
  ]
}
```

```json
{
  "skill": "excel-consolidate",
  "script": "consolidate.mjs",
  "args": ["compare", "outputs/applied.json", "2025-04", "2025-05", "--out", "outputs/report.json"]
}
```

集計結果を Excel にして `outputs/` に置く。`sheet` が 明細 と 前月比 の2シートの内容を
`outputs/book.json` に出し、`office-reader` の `ooxml.mjs` の `write` がファイルにする
（ファイル名は `consolidated-<to>.xlsx`、`<to>` は計画の `to`）:

```json
{
  "skill": "excel-consolidate",
  "script": "consolidate.mjs",
  "args": ["sheet", "outputs/report.json", "--out", "outputs/book.json"]
}
```

```json
{
  "skill": "office-reader",
  "script": "ooxml.mjs",
  "args": ["write", "outputs/book.json", "outputs/consolidated-2025-05.xlsx"]
}
```

- 見出しの単位が計画と食い違うと、スクリプトは止まる（終了コード1）。単位を直した計画を `outputs/plan.json` に `Write` し、もう一度承認を受ける。
- `skipped` に出た行（小計・注記・数値でない金額）は、件数と理由を説明に書く。

## 4. 説明を書く

- 数字は `compare` の出力（`report.json`）にあるものだけを、スクリプトの出力どおり（円、3桁区切り、％は小数1桁）に書く。暗算した合計や差額を書かない。
- 増減の大きい拠点から順に、どの行（`@src`）が効いているかを示す。
- 最後に `report.json` の中身を ```json のコードブロックでそのまま付ける。
