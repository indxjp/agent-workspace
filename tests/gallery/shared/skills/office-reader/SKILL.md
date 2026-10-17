---
name: office-reader
description: Excel（.xlsx）と Word（.docx）を、ライブラリなしの Node スクリプトで読む。結合セル・複数シート・見出しを保ったまま JSON にする。
---

# Office ファイルの読み方

Agent Workspace はアップロードされたファイルを解析しません。xlsx と docx は zip に入った XML なので、
このスキルの `scripts/ooxml.mjs` で JSON にしてから読みます。Node だけで動き、追加のパッケージは不要です。

`run_skill_script` ツール（`skill`・`script`・`args`）で動かします。結果は標準出力の JSON です。
シェルのある実行では、同じ引数で `ooxml.mjs` を `node` に渡しても同じ結果になります。

## Excel

```json
{ "skill": "office-reader", "script": "ooxml.mjs", "args": ["xlsx", "<ファイル.xlsx>"] }
```

出力: `{ "sheets": [{ "name", "rows": [[...]], "merges": ["A1:C1"], "cells": { "B3": 1200 } }] }`

- `rows` は結合セルの値を結合範囲全体に埋めた2次元配列。多段見出しを1行に畳むときに使う。
- `cells` は元のセル番地と値。集計結果に「どのファイルのどのセルか」を残すときは、こちらの番地を使う。
- 数値は数値のまま。和暦・「千円」などの単位は、表の見出しを読んで判断し、勝手に換算しない。

## Word

```json
{ "skill": "office-reader", "script": "ooxml.mjs", "args": ["docx", "<ファイル.docx>"] }
```

出力: `{ "paragraphs": [{ "style": "Heading1" | null, "text": "..." }] }`。条項番号は見出しスタイルか、
本文先頭の「第N条」で判断する。

## してはいけないこと

- 数値をモデルの頭の中で合計しない。合計・換算は必ずスクリプトで行い、その出力を引用する。
- 読めなかったシートや段落を黙って捨てない。読めなかったことを回答に書く。
