---
id: TAX-01
title: Registration number
---

(A sample of the invoice intake rules in the accounting manual of a fictional company, Komadori Seisakusho Co., Ltd. Summary of the version revised on 2026-04-01. It does not state how anything is treated for tax.)

## Rule

Judge whether the invoice carries the supplier's registration number ("T" followed by 13 digits).

- OK: a registration number of "T" followed by 13 digits is printed.
- NG: no registration number, or "T" is not followed by exactly 13 digits.

## Action

For NG, hold the entry, pass it to the accounting team, and ask the supplier for an invoice with its registration number.
