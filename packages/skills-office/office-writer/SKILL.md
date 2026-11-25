---
name: office-writer
description: Word（.docx）・PowerPoint（.pptx）・Excel（.xlsx）のファイルを、型の決まった JSON モデルから、ライブラリなしの Node スクリプトで書く。見出し・段落・箇条書き・表、スライドのタイトル・箇条書き・表、シートの型付きセルに対応する。
---

# Office ファイルの書き方

文書の中身を JSON の「モデル」に書き、このスキルの `write.mjs` で `.docx`・`.pptx`・`.xlsx` にします。
HTML や Markdown からの変換ではありません。Node だけで動き、追加のパッケージは不要です。

1. モデルを作業ディレクトリの JSON ファイルに書く（例: `drafts/proposal.json`）。
2. `run_skill_script` ツールで `write.mjs` を実行する。

```json
{
  "skill": "office-writer",
  "script": "write.mjs",
  "args": ["drafts/proposal.json", "outputs/提案書.pptx"]
}
```

成功すると標準出力に `{ "written": "outputs/提案書.pptx", "bytes": 8217 }` が出ます。

## 書き込みと承認

- 書き出し先は `outputs/` の下にする。`outputs/` のファイルは、実行の成果物として呼び出し元に返る。
- `outputs/` に自分でファイルを書かない（`Write` など）。そこに置く成果物は、このスクリプトで書き出したファイルだけ（ほかの書き込みはプラットフォームが拒否する）。
- このスクリプトの実行は、ほかのファイル書き込みと同じく承認を待つ。承認の前に、何を書くのか
  （ファイル名、見出しやスライドの一覧）を利用者に示す。
- 同じ名前のファイルがすでにあるときは書かない（`output_exists`）。上書きせず、新しい名前で書く。

## モデル

`format` は `"docx"`・`"pptx"`・`"xlsx"` のどれかで、書き出し先の拡張子と同じにする。知らない
キーがあると断られる。文字列の中の改行（`\n`）は、そのまま改行として書かれる。

### Word（docx）

```json
{
  "format": "docx",
  "title": "作業手順書",
  "blocks": [
    { "type": "heading", "level": 1, "text": "第1章 目的" },
    { "type": "paragraph", "text": "本書は出荷検査の手順を定める。" },
    { "type": "list", "items": ["安全靴", "保護眼鏡"] },
    { "type": "list", "ordered": true, "items": ["電源を切る", "表示灯の消灯を確認する"] },
    {
      "type": "table",
      "header": ["工程", "時間（分）"],
      "rows": [
        ["組立", 30],
        ["検査", 12.5]
      ]
    }
  ]
}
```

- `heading` の `level` は 1〜6。Word の「見出し 1」〜「見出し 6」になり、目次やナビゲーションに出る。
- `list` は `ordered: true` で番号付き（リストごとに 1 から）、なければ箇条書き。
- `table` の各行は、`header`（なければ最初の行）と同じ列数にする。セルは文字列か数値。

### PowerPoint（pptx）

```json
{
  "format": "pptx",
  "slides": [
    {
      "title": "提案の概要",
      "bullets": ["課題: 月次集計が手作業", "効果: 月20時間の削減（試算）"]
    },
    { "title": "費用", "table": { "header": ["項目", "金額（円）"], "rows": [["月額", 50000]] } }
  ]
}
```

- スライドは 16:9。`title` は必須で、`bullets`（20 項目まで）と `table`（15 行・8 列まで）は任意。
- 両方あるときは、箇条書きが上、表が下に並ぶ。入りきらない量は、スライドを分ける。

### Excel（xlsx）

```json
{
  "format": "xlsx",
  "sheets": [
    {
      "name": "売上",
      "header": ["拠点", "売上（千円）", "達成", "締め日"],
      "rows": [
        ["東京", 1200, true, { "date": "2026-11-30" }],
        ["大阪", null, false, null]
      ]
    }
  ]
}
```

- セルは文字列・数値・`true`/`false`・`null`（空）・`{ "date": "YYYY-MM-DD" }`（日付。1900-03-01 以降）。
- `header` は太字になり、スクロールしても見えるよう固定される。
- シート名は 31 文字まで、`[ ] : * ? / \`・タブ・改行を含めない、`'` で始めたり終えたりしない、
  `History`（Excel の予約名。大文字小文字を問わない）にしない、ほかのシートと（大文字小文字を無視して）重ならない。
- 数値は数値のまま書く。計算結果はスクリプトで出した値を入れ、モデルの頭の中で計算しない。

## 断られたとき

終了コード 1 で、標準エラーに `{"error": "<名前>", "message": "...", "issues": [...]}` が出ます。
ファイルは書かれていません。

- `invalid_model`: モデルの誤り。`issues` の各 `path`（例: `$.slides[2].table.rows[0]`）と `message` を
  見て直し、もう一度実行する。
- `invalid_json`（JSON として読めない）、`unreadable_model`（モデルのファイルがない）、
  `model_too_large`（8 MiB を超える）。
- `extension_mismatch`: `format` と書き出し先の拡張子が違う。
- `output_exists`: 書き出し先がすでにある。`output_not_writable`: 書けない場所（`outputs/` の下にする）。

上限: 文字列 32,767 文字、Word のブロック 5,000・表 1,000 行 32 列、スライド 200 枚、シート 64 枚・
1 行 16,384 列・合計 1,000,000 セル。上限を超えると切り詰めずに断られる。

## してはいけないこと

- 書式（色・フォント・画像・結合セル・数式）は書けない。必要なら、書けないことを回答に書く。
- 利用者に見せていない内容を書き出さない。書いたファイル名を回答に書く。
