---
name: excel-consolidation
description: How branch sales workbooks of different layouts are consolidated into one table and compared month on month with this skill's script (run_skill_script, analyse.mjs), and rendered with office-writer.
---

# Consolidating the branch workbooks

Every number comes from the script. Never add, subtract, convert a unit or round in your head.

## The layouts it reads

Each branch keeps its own layout, and the script reads them all as they are:

- the first sheet, whatever its name (売上明細, Sheet1, 実績, R7.5 …), its first non-blank row the
  header;
- the columns found by name, in any order: the date (日付・売上日・計上日 / date, sales date, booked
  on), the category (区分・品目 / category, item) and the amount (金額・売上金額・売上 / amount, sales);
- the unit from the amount's header: 千円 / thousand is ×1000, otherwise yen;
- a date as YYYY-MM-DD or YYYY/M/D; a row whose category starts with 小計・合計 / subtotal, total,
  or with no date or no number (a note such as 「※ 返品分は含まない」), is skipped and named.

A workbook without a date, a category and an amount column (an expense report) or with no row (a
template) is left out with the reason. A text file is not a workbook: the search may return one,
and the script never reads it.

## Running it

There is no shell. The first argument is the language's folder; the months are YYYY-MM:

```json
{
  "skill": "excel-consolidation",
  "script": "analyse.mjs",
  "args": [
    "excel-consolidation/ja",
    "--from",
    "2025-04",
    "--to",
    "2025-05",
    "--book",
    "outputs/consolidated-2025-05.json"
  ]
}
```

It prints `layouts` (each workbook's branch, unit, rows kept and rows skipped), `excluded` (each file
left out and why), `branches` (each branch's total in yen for `from` and `to`, the `change` and the
`changePct`, largest change first, with its `categories`: each category's two months and change,
largest change first), `total`, and `book`, the model it wrote. A file it cannot read
a month that is not YYYY-MM, or a `--book` file that exists already (add `_v2`) is refused with `{ "error", "message" }`: say what it says.

## Saving the workbook

`book` is an office-writer model of two sheets: Detail (every row in yen, with its source file and
row) and Comparison (the branches and the total). Render it as it is:

```json
{
  "skill": "office-writer",
  "script": "write.mjs",
  "args": ["outputs/consolidated-2025-05.json", "outputs/consolidated-2025-05.xlsx"]
}
```

## Explaining the change

Name the branches with the largest change first, the change and the change % as printed, and the
categories behind it from the branch's `categories` (each with its change as printed). Say which units were converted (a branch that
reports in 千円) and which rows were skipped, so the reader can check them against the originals.
