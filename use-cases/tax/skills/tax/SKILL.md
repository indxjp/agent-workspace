---
name: tax
description: How to check a supplier invoice and its accounting entry against the company's own accounting rules in `tax/standards/` (TAX-01 to TAX-05) as OK, caution (要注意) or NG, without giving tax advice.
---

# Checking an invoice against the company's accounting rules

The rules are five, one file each in `tax/standards/`: `TAX-01` the supplier's registration
number, `TAX-02` the tax rate on each line and the totals per rate, `TAX-03` the company's tax code
for each kind of item (the table in that file), `TAX-04` the issuer, the date and the addressee,
`TAX-05` the match between the invoice and the entry. Each file says which facts are `OK`, caution
(`要注意`) and `NG`, and the action to take. These are the company's own rules, written by its
accounting team; apply them as written and add nothing from tax law.

Where each fact comes from:

- from the invoice: the issuer, the registration number, the date, the addressee, each line's item,
  kind of item and tax rate, the totals per rate and the total, as printed;
- from the entry export (the rows of that invoice number): each line's tax code and the total
  typed in.

For each rule:

1. Quote the facts the rule names, from the invoice and the entry, exactly as printed.
2. Compare them as written: a code with the table of `TAX-03`, a number with a number. Never work
   out a tax amount or a total yourself.
3. Take the verdict and the action the rule names for those facts. For `TAX-03`, the action names
   the line and the code the table gives.

The verdicts are input for the accounting team. There is no overall verdict and no statement on
how the tax office would treat the invoice.
