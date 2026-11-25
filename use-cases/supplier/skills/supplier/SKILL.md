---
name: supplier
description: How the monthly supplier quality report is put together from the incoming inspection exports, the claims list and the company's supplier quality rules.
---

# The exports

The `supplier` folder holds, in Japanese under `supplier/ja/` and in English under `supplier/en/`:

- The incoming inspection results by supplier (`受入検査_仕入先別_*.csv` /
  `incoming-inspection_by-supplier_*.csv`): one row per month and supplier, with the lots
  inspected and rejected, the quantities, and the defect rate in ppm that the quality system
  computed (`不良率ppm` / `defect_ppm`).
- The same for all suppliers together (`受入検査_全体推移_*.csv` /
  `incoming-inspection_all-suppliers_*.csv`): one row per month.
- The claims list (`クレーム_*.csv` / `claims_*.csv`): one row per claim, with its id (`CL-xxx`),
  date, supplier, part, description and status (`対応中` / `open`, `完了` / `closed`).
- The company's rules (`仕入先品質の基準.md` / `supplier-quality-rules.md`): when a supplier is on
  watch.

Copy every defect rate exactly as the export has it: never compute, average or round one.

# Deciding watch or ok

Apply the rules file's conditions to each supplier for the month reported, and nothing else:
compare the rates as the export gives them. List every condition that holds as a reason, naming the
months and rates or the claim id (`610 ppm, over 500`, `420 → 610`, `CL-031 open`). A supplier for
which none holds is `ok`, with no reason.

# The report

One Markdown file, `supplier-reports/<YYYY-MM>_supplier.md`, in the language of the request:

1. A heading with the month.
2. **On watch**: each supplier on watch, with its rate for the month, the reasons, and its open
   claims (id, part and what the description says).
3. **OK**: the other suppliers, one line each with the rate.
4. **All suppliers**: the all-supplier rate for each month of the export, oldest first.

Every line names its source as `file#row key` (`受入検査_仕入先別_2026-06_2026-11.csv#2026-11 S-02`,
`クレーム_2026.csv#CL-031`). In typed output, `trend` is the all-supplier rate per month, oldest
first, as the export has it.
