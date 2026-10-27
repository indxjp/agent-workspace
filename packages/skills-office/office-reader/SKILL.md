---
name: office-reader
description: PDF・Excel（.xlsx）・Word（.docx）・DXF 図面を、ライブラリなしの Node スクリプトで読む。結合セル・複数シート・見出し・ページ・図面の文字を保ったまま JSON にする。
---

# 文書ファイルの読み方

アップロードされたファイルは、保存時には解析されません。このスキルのスクリプトを、読む必要が出たときに
実行して JSON にします。Node だけで動き、追加のパッケージは不要です。OCR はないので、画像だけの
PDF（スキャン）の文字は読めません。

`run_skill_script` ツール（`skill`・`script`・`args`）で動かします。結果は標準出力の JSON です。
読めなかったときは終了コード 1 で、標準エラーに `{"error": "<名前>", "message": "..."}` が出ます。
シェルのある実行では、同じ引数で `scripts/` のファイルを `node` に渡しても同じ結果になります。

Word と DXF は、最後に出力先の JSON ファイル（作業ディレクトリの中）を渡せます。同じ JSON をそのファイルに
書き、標準出力には `{ "written": "<出力.json>" }` だけを出します。大きな図面や文書を、モデルを通さずに
次のステップへ渡すときに使います（フォルダは自動で作られる）。

| 形式 | script | args |
| --- | --- | --- |
| PDF | `pdf.mjs` | `["<ファイル.pdf>"]` |
| Excel | `ooxml.mjs` | `["xlsx", "<ファイル.xlsx>"]` |
| Word | `ooxml.mjs` | `["docx", "<ファイル.docx>"]` または `["docx", "<ファイル.docx>", "<出力.json>"]` |
| DXF | `dxf.mjs` | `["<ファイル.dxf>"]` または `["<ファイル.dxf>", "<出力.json>"]` |

```json
{ "skill": "office-reader", "script": "pdf.mjs", "args": ["<ファイル.pdf>"] }
```

## PDF

出力: `{ "pages": [{ "number": 1, "text": "...", "unreadable": true }] }`

- `text` は1ページ分。文字の並びごとに1行で、表は列ごとの空白区切りになる。
- `text` が空の `""` のページは、画像だけのページ（スキャン）。文字は読めていないので、内容を推測せず、
  読めなかったと回答に書く。
- `unreadable: true` のページは、このスクリプトが解読できない文字（未対応のフィルタ、文字対応表のない
  日本語フォントなど）を含む。同じように、読めなかったと書く。
- 失敗の名前: `encrypted_pdf`（パスワード付き。中身は一切読まない。パスワードを推測しない。利用者に
  パスワードなしの PDF を求める）、`not_a_pdf`、`corrupt_pdf`。
  大きすぎる／展開すると巨大になるファイルは、読まずに断られる（`file_too_large`、`too_many_objects`、`too_many_pages`、`page_tree_too_deep`、`stream_too_large`、`inflated_too_large`）。

## Excel

出力: `{ "sheets": [{ "name", "rows": [[...]], "merges": ["A1:C1"], "cells": { "B3": 1200 } }] }`

- `rows` は結合セルの値を結合範囲全体に埋めた2次元配列。多段見出しを1行に畳むときに使う。
- `cells` は元のセル番地と値。集計結果に「どのファイルのどのセルか」を残すときは、こちらの番地を使う。
- 数値は数値のまま。和暦・「千円」などの単位は、表の見出しを読んで判断し、勝手に換算しない。
- 失敗の名前（Excel と Word 共通）: `archive_too_large`、`too_many_entries`、`entry_too_large`、`corrupt_archive`（zip として読めない）。
  大きすぎる／展開すると巨大になるファイルは、読まずに断られる。断られたと回答に書く。

## Word

出力: `{ "paragraphs": [{ "style": "Heading1" | null, "text": "..." }] }`。条項番号は見出しスタイルか、
本文先頭の「第N条」で判断する。

## DXF（図面）

出力: `{ "version", "codepage", "layers": [...], "blocks": [...], "counts": { "LINE": 120 }, "texts": [...], "inserts": [...], "lines": [...], "circles": [...] }`

- `texts` は図面上の文字: `TEXT`・`MTEXT`（書式コードは除去済み）・`ATTRIB`/`ATTDEF`（`tag` が属性名）・
  `DIMENSION`（`text` が空なら `measurement` の寸法値が表示される）。`layer`・`block`・位置 `x`/`y` 付き。
  `TEXT`・`MTEXT`・`ATTRIB`・`ATTDEF` には文字の高さ `height` も付く。
- `lines` は `LINE` の `x1`/`y1`/`x2`/`y2`、`circles` は `CIRCLE` の中心 `x`/`y` と半径 `r`（どちらも `layer`・`block` 付き）。
  座標を出すのはこの2種類だけで、円弧・ポリライン・ハッチなどは `counts` の個数でしか分からない。
- `counts` は図形の種類ごとの数。`lines`/`circles` 以外の形は座標が読めていないので、形について答えるときは
  読めていない種類があることを回答に書く。
- 失敗の名前: `binary_dxf`（バイナリ DXF。ASCII で書き出し直してもらう）、`unsupported_codepage`、
  `not_a_dxf`、`file_too_large`（大きすぎる）。

## 書く

スクリプトが作った `{ "sheets": [{ "name", "rows": [[...]] }] }`（Excel）か `{ "paragraphs": [{ "text" }] }`（Word）の
JSON ファイルを、`write` で `.xlsx` / `.docx` にする。値と段落のスタイルだけを書き、書式は付かない。
`outputs/` に書いたファイルは、実行の成果物として呼び出し元に返る。

```json
{ "skill": "office-reader", "script": "ooxml.mjs", "args": ["write", "<book.json>", "outputs/<ファイル名>.xlsx"] }
```

## してはいけないこと

- 数値をモデルの頭の中で合計しない。合計・換算は必ずスクリプトで行い、その出力を引用する。
- 読めなかったシート・ページ・段落を黙って捨てない。読めなかったことを回答に書く。
