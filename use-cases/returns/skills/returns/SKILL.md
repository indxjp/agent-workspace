---
name: returns
description: How to check a customer's return or refund request against the shop's return policy in `returns/standards/` (RET-01 to RET-05) and the order record in `returns/orders/orders.csv`, as OK, caution (要確認) or NG, without deciding the refund.
---

# Checking a return request against the policy

The policy is five items, one file each in `returns/standards/`: `RET-01` the return deadline,
`RET-02` the condition of the item, `RET-03` items that cannot be returned, `RET-04` the match with
the order, `RET-05` who pays the return shipping. Each file's rule says which facts are `OK`,
caution (`要確認`) and `NG`. Apply it as written; it is the shop's rule, not yours.

Where each fact comes from:

- from the request form: the request date, the order number, the item, the quantity, the reason,
  the condition and whether a photo is attached;
- from the order record (the row of that order number and item): the delivery date, the return
  deadline and the "returnable" column. The deadline is the order system's; compare the request date
  with it as two dates and never work out a deadline from the delivery date.

For each item:

1. Quote the facts the rule names, from the form and the order row.
2. Take the verdict the rule names for those facts. A reason the customer gives is their claim: a
   defect claim is a reason to inspect (caution where the rule says so), never a proven defect.
3. For caution and `NG`, say what the support desk could confirm or ask the customer.

The verdicts are input for a person. There is no overall verdict, no refund amount and no decision
in the table.
