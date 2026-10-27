---
name: dxf-draft
description: office-reader が読んだ DXF 図面（JSON）から、寸法の変更点だけを反映した新図面（未検図）を書く。Node だけで動く。
---

# DXF 図面の流用作図

Agent Workspace はアップロードされた図面を解析しません。DXF を読むのは組み込みの `office-reader` スキル
（`dxf.mjs`）で、このスキルの `scripts/dxf.mjs` はその JSON から新図面の DXF を書きます。Node だけで動き、
追加のパッケージは不要です。スクリプトは `run_skill_script` ツール（`skill`・`script`・`args`）で動かします。
シェルはありません。読めるのは作業ディレクトリの中だけで、書けるのは書き込み可で渡されたフォルダ
（`drafts`）と、実行の成果物を置く `outputs` だけです。

## 元図を読む

出力先（`drafts/` の中）を付けると、出力（`lines`・`circles`・`texts`・`counts`・`blocks` ほか）は
そのファイルに書かれ、標準出力には `{"written": "drafts/BRK-1003.base.json"}` だけが出る。`Write` は使わない。
以降の `draft` はこのファイルを元図として読む。

```json
{
  "skill": "office-reader",
  "script": "dxf.mjs",
  "args": ["drawings/BRK/BRK-1003.dxf", "drafts/BRK-1003.base.json"]
}
```

- 外形（`OUTLINE` 層の LINE）、穴（`HOLE` 層の CIRCLE）、表題欄（`TITLE` 層の TEXT）、注記（`NOTE` 層の TEXT）が
  流用作図の対象。寸法はすべて mm。穴の位置は外形の左下角からの距離、直径は半径の2倍。
- `counts` に LINE・CIRCLE・TEXT 以外の要素（ARC・LWPOLYLINE・INSERT など）があるか、`blocks` が空でない
  図面は、座標を読めないので `draft` が拒否する。回答にそのことを書く。
- 外形が矩形でない図面（L形・切欠きあり）も、伸縮で流用できないので `draft` が拒否する。

## 流用して作図する

変更セット（JSON）を `Write` で `drafts/BRK-1101.changes.json` に書く。これが設計者の承認を待つ唯一の `Write`
で、承認されると（`approved`）同じ内容でもう一度 `Write` してから `draft` に渡す:

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
  "args": [
    "draft",
    "drafts/BRK-1003.base.json",
    "drafts/BRK-1101.changes.json",
    "outputs/BRK-1101.dxf"
  ]
}
```

- 変更セットには、要件が変える項目だけを書く。元図と同じ値は書かない（`material`・`thickness`・
  `partName` は元図と違うときだけ）。`width`・`height` は必須で、変えない方は元図の値を書く。
  `holes` を省くと元図の穴をそのまま残し、書くと元図の穴をすべて置き換える。
- 新図面は `outputs/<新図番>.dxf` に書く。そこに置いたファイルが実行の成果物として返る。
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
- 文字コード: 書き出す DXF は AC1027（AutoCAD 2013）の UTF-8 で、日本語の文字がそのまま入る。
  元図の読み方（Shift_JIS の DXF の扱いを含む）は `office-reader` の SKILL.md に従う。
