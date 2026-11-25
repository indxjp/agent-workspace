---
name: price-guard
description: How to check a sales quote against the company's pricing rules in `price-guard/standards/` (PG-01 to PG-05) and the floor prices in `price-guard/price-list/`, as OK, caution (要注意) or NG, without changing a price.
---

# Checking a quote against the pricing rules

The rules are five, one file each in `price-guard/standards/`: `PG-01` the discount rate of each
line, `PG-02` the floor price of each line, `PG-03` the payment terms, `PG-04` how long the quote is
valid, `PG-05` free items and special conditions. Each file says which facts are `OK`, caution
(`要注意`) and `NG`, and the action to take. Apply it as written; it is the company's rule, not
yours.

Where each fact comes from:

- from the quote: each line's part number, list price, discount rate and offered unit price; the
  payment terms, the validity, the remarks and the sales manager's approval number, with what it
  covers;
- from the price list (the row of the line's part number): the floor price, `下限単価` or
  `floor_price`. A part number the list does not have is caution under `PG-02`, never a guess.

For each rule:

1. Quote the facts the rule names, from the quote and the price list, exactly as printed.
2. Compare them as written: a rate with the rule's thresholds, a unit price with the floor price.
   Never work out a rate, a total or a margin yourself.
3. An approval number counts only for what the quote says it covers (a line, or a condition).
4. Take the verdict and the action the rule names for those facts.

The verdicts are input for the sales manager. There is no overall verdict and no new price in the
table.
