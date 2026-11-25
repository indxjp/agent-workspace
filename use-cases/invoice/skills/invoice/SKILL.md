---
name: invoice
description: How to match each line of an incoming invoice with its purchase order and delivery note under the rules in `invoice/standards/` (MATCH-01 to MATCH-04) as OK, caution (要注意) or NG, with the rule's action.
---

# Matching an invoice line with its order and delivery note

The rules are four, one file each in `invoice/standards/`: `MATCH-01` the item is on the order,
`MATCH-02` unit price, `MATCH-03` three-way quantity match, `MATCH-04` reference numbers. Each
file's rule says which result is `OK`, caution (`要注意`) or `NG`. Apply the rule as written; it is
the company's decision, not yours.

For each invoice line, in this order:

1. `MATCH-01`: find the order line with the same part number. None (a shipping charge or a fee
   included) is `NG`; stop there for this line.
2. `MATCH-02`: compare the invoice's unit price with the order's, digit by digit as written
   (`6.5` is not `6`).
3. `MATCH-03`: find the delivery note line with the same part number and read its accepted
   quantity (`検収数量` / `accepted_qty`), not the delivered quantity. Compare the invoiced quantity
   with it and with the ordered quantity.
4. `MATCH-04`: check that the order number is on the line or in the invoice header, and that the
   line gives a delivery note number.

The line's verdict is the strictest any rule gives, citing the rule that decides it; mention any
other rule it breaks in the reason. A line every rule accepts is `OK`, citing `MATCH-03`, the
three-way match itself. Compare the numbers as the documents give them; never add up, multiply or
recompute an amount. For caution and `NG`, the action is the rule's action. For `OK`, leave it
empty.
