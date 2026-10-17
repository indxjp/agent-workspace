---
name: dxf-draft
description: ASCII DXF（R12）図面を JSON に読み、過去図面から寸法の変更点だけを反映した新図面（未検図）を書く。Node だけで動く。
---

# DXF 図面の読み方と流用作図

Agent Workspace はアップロードされた図面を解析しません。DXF はテキスト形式なので、このスキルの
`scripts/dxf.mjs` で読み書きします。Node だけで動き、追加のパッケージは不要です。
スクリプトは `run_skill_script` ツール（`skill`・`script`・`args`）で動かします。シェルはありません。
読めるのは作業ディレクトリの中だけで、書けるのは書き込み可で渡されたフォルダ（`drafts`）だけです。

## 読む

```json
{
  "skill": "dxf-draft",
  "script": "dxf.mjs",
  "args": ["summary", "drawings/BRK-1003.dxf"]
}
```

出力: `{ drawingNo, partName, material, thickness, width, height, rectangular, holes: [{ x, y, diameter }], notes, title, unreadEntities }`

- 寸法はすべて mm。穴の位置は外形の左下角からの距離、`diameter` は直径（φ）。
- `rectangular: false` の図面（L形・切欠きあり）は伸縮で流用できない。`draft` は拒否する。
- `unreadEntities` に要素があれば、その要素は読めていない。回答にそのことを書く。

## 流用して作図する

変更セット（JSON）を書き、`draft` に渡す:

```json
{
  "base": "BRK-1003",
  "drawingNo": "BRK-1101",
  "width": 140,
  "height": 90,
  "holes": [
    { "x": 15, "y": 15, "diameter": 9 },
    { "x": 125, "y": 15, "diameter": 9 },
    { "x": 15, "y": 75, "diameter": 9 },
    { "x": 125, "y": 75, "diameter": 9 }
  ],
  "drafter": "設計AI",
  "date": "2026-10-04"
}
```

```json
{
  "skill": "dxf-draft",
  "script": "dxf.mjs",
  "args": ["draft", "drawings/BRK-1003.dxf", "drafts/BRK-1101.changes.json", "drafts/BRK-1101.dxf"]
}
```

- 変更セットには、要件が変える項目だけを書く。元図と同じ値は書かない（`material`・`thickness`・
  `partName` は元図と違うときだけ）。`width`・`height` は必須で、変えない方は元図の値を書く。
  `holes` を省くと元図の穴をそのまま残し、書くと元図の穴をすべて置き換える。
- 出力は新図面の要約に、元図との差を表す `changes`（例: `高さ 80 → 90`、`穴 (15,65)φ9 → (15,75)φ9`）と、
  変わっていない値を表す `kept`（例: `幅 140（元図のまま）`）が付く。回答の変更点の箇条書きはこの
  2つをそのまま写す。
- 出力の `changeSet` は、元図と同じ値の項目（`material`・`thickness`・`partName`・`holes`）を除いた
  変更セット。回答の ```json コードブロックにはこれをそのまま貼る。
- 外形は元図の左下角を基準に、指定の幅×高さの矩形に描き直す。注記と表題欄の他の項目は元図のまま。
- 表題欄は図番・作成を更新し、`検図 未`、`状態 未検図`、`派生元 <元図番>` を書く。
- 穴が外形からはみ出す、穴同士が重なる、元図の外形が矩形でない、図番が元図と同じ、のどれかに
  当たると、ファイルを書かずに終了コード 1 で理由を出す。理由をそのまま設計者に伝える。

## してはいけないこと

- 要件にも元図にもない寸法を作らない。足りない寸法は設計者に聞く。
- `draft` の結果を検図済みとして扱わない。出図の判断は設計者の検図による。
- 文字コード: このスクリプトは UTF-8 の DXF を読み書きする。Shift_JIS（ANSI_932）の R12 DXF は
  CAD 側で UTF-8（R2007 以降）に書き出してから使う。
