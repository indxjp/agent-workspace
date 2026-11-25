---
name: cad-drafting
description: Which past drawing (DXF) can be reused for a new sheet-metal part, and how this skill's script (run_skill_script, draft.mjs) writes the new, unchecked drawing with its title block, notes and parts list.
---

# Reusing a past drawing

## Reading a past drawing

A past drawing is an ASCII DXF: pairs of lines, a group code then its value. Its entities are:

| Entity | Layer   | What it is                                                                  |
| ------ | ------- | --------------------------------------------------------------------------- |
| LINE   | OUTLINE | an edge of the outline: from (10, 20) to (11, 21), in mm                    |
| CIRCLE | HOLE    | a hole: its centre (10, 20) and its radius (40); the diameter is twice that |
| TEXT   | TITLE   | a title block field (1): 図番 / No., 品名 / Part, 材質 / Material, …        |
| TEXT   | NOTE    | a note (1): corners, burrs, surface finish                                  |

A drawing can be reused only when its outline is four LINEs forming a rectangle from (0, 0): its
width is the largest x, its height the largest y, and each hole's position is its centre as
written. A drawing with more outline lines (an L shape, a notch) or any other entity (ARC,
LWPOLYLINE, INSERT) is not stretched: say so, and suggest drawing it by hand or another candidate.

## The changes

Compare the requirement with the base, item by item, and list each one that differs as
`<item> <base> → <new>` (for example `高さ 80 → 90`, `穴 (15,65)φ9 → (15,75)φ9`), and the ones that
stay (`幅 140（元図のまま）`). Copy the values as written; there is nothing to compute.

## Writing it

Run the script with `run_skill_script`. There is no shell. Every list is one argument, its items
separated by `;`:

```json
{
  "skill": "cad-drafting",
  "script": "draft.mjs",
  "args": [
    "outputs/BRK-1101.dxf",
    "--width",
    "140",
    "--height",
    "90",
    "--holes",
    "15,15,9;125,15,9;15,75,9;125,75,9",
    "--title",
    "図番 BRK-1101;品名 ブラケット;材質 SUS304;板厚 t2.0;尺度 1:1;作成 <today> 設計AI;検図 未;状態 未検図;派生元 BRK-1003",
    "--notes",
    "注記1 指示なき角部は C0.5;注記2 バリ・カエリなきこと;注記3 表面処理 なし（2B仕上げ）",
    "--parts",
    "部品表 1 BRK-1101 ブラケット SUS304 t2.0 1個"
  ]
}
```

- `--holes`: each hole as `x,y,diameter` in mm from the lower left corner.
- `--title`: the base's title block with the new drawing number, the material and thickness of the
  requirement, today as 作成 / Drawn, `検図 未` / `Checked -`, `状態 未検図` / `Status Unchecked`,
  and `派生元 <base>` / `Derived <base>`. In English the fields are `No.`, `Part`, `Material`,
  `Thickness`, `Scale`, `Drawn`, `Checked`, `Status` and `Derived`.
- `--notes`: the base's notes as they are, in their order.
- `--parts`: the parts list, one row per part: `部品表 <No.> <drawing number> <part name>
<material> <thickness> <quantity>` / `Parts <No.> <drawing number> <part name> <material>
<thickness> x<quantity>`. A single part is one row with quantity 1.

The script draws the outline from (0, 0), the holes, the title block to the right and the notes,
the parts list and a last note `未検図` under the outline, and prints what it wrote. It refuses
(`{ "error", "message" }`) a size that is not mm or a hole that is not inside the outline
(`not_inside`), a title that marks the draft checked or released (a 検図 / Checked other than
未 / -, a 状態 / Status other than 未検図 / Unchecked: `not_a_draft`), and an output that exists
already (`output_exists`): it never overwrites.
