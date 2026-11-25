---
name: quotation
description: How a sheet-metal part (SS400, SUS304, A5052) is priced from the ERP's rate table with this skill's script (run_skill_script, estimate.mjs), and what a quote draft says.
---

# Pricing a part

Every amount comes from the script. Never add, multiply, divide or round in your head, and never
write an amount the script did not print.

Run it with `run_skill_script`. There is no shell. The first argument is the rate table's `path`
as `search_files` returned it (`quotation/ja/ERP_単価表.csv` or `quotation/en/erp-rates.csv`), the
second the material as the spec writes it, then every dimension as an option, in mm, as plain
numbers:

```json
{
  "skill": "quotation",
  "script": "estimate.mjs",
  "args": [
    "quotation/ja/ERP_単価表.csv",
    "SS400",
    "--length",
    "200",
    "--width",
    "100",
    "--thickness",
    "3.2",
    "--holes",
    "4",
    "--diameter",
    "10",
    "--bends",
    "2",
    "--quantity",
    "50"
  ]
}
```

With no holes, pass `--holes 0 --diameter 0`. It prints
`{ material, quantity, breakdown: { material, cutting, bending, setup }, cost, unitPrice, total }`
in yen, before tax. It refuses (`{ "error", "message" }`, exit 1 or 2) a material or a thickness the
rate table has no row for, a dimension that is not a number and a quantity that is not whole
pieces: say what the message says and give no price.

## How the script prices (for reading its result, not for computing)

| Line       | Rule                                                                         |
| ---------- | ---------------------------------------------------------------------------- |
| Material   | the outline's weight × the material price per kg ÷ the yield, to the yen     |
| Cutting    | the outline and the holes' circumference in metres × the cutting rate        |
| Bending    | bends × the rate per bend                                                    |
| Setup      | the setup per lot ÷ the quantity, rounded up to the yen                      |
| Unit price | the four lines × (1 + margin), rounded up to 10 yen; total = unit × quantity |

The cutting rate is the material's row with the smallest thickness limit the part fits under. The
blank is the outline: nesting, scrap value and surface finish (polishing, plating) are not priced;
say "表面処理は別途" / "surface finish is quoted separately" when the spec names one.

## Similar orders

From the past orders, name only those of the same material and kind of part, with the order
number, part name, quantity, unit price and date. They show the customer's history; they never
change the script's amounts.

## Registering in the ERP

`create_quote` takes `customer`, `drawingNo`, `partName`, `material`, `quantity`, `unitPrice`,
`total` and `note`. The values are the spec's and the script's. `note` carries a discount request
or anything else the approver must decide, in one sentence; otherwise "見積下書き（AI作成）" / "Draft
quote (drafted by AI)".
