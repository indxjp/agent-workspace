---
name: change-4m
description: How to check a 4M change request against the plant's change control rules in `change-4m/standards/` (CHG-01 to CHG-05) and map its impact from the parts usage list in `change-4m/usage/`, as OK, caution (要注意) or NG, without approving the change.
---

# Checking a 4M change request

The rules are five, one file each in `change-4m/standards/`: `CHG-01` the kind of change (man,
machine, material or method), `CHG-02` the products affected, `CHG-03` the first-lot inspection,
`CHG-04` telling the customer, `CHG-05` the switch-over date and the old stock. Each file says which
facts are `OK`, caution (`要注意`) and `NG`, and the action to take. Apply it as written; it is the
plant's rule, not yours.

Where each fact comes from:

- from the request: the kind of change, the code of what is changed (a material, a machine, a
  process), the products it lists as affected, the first-lot inspection plan, whether the customer
  is told, the switch-over date and what happens to the old stock;
- from the parts usage list (every row whose changed item is that code): the product numbers, the
  process, the customer and the "customer notice" column (`顧客届出` / `customer_notice`).

The impact is exactly the rows of the usage list for that code: list every product number, and
mark the ones the request leaves out. A product the request names that the list does not give is
mentioned in one sentence, without a verdict.

For each rule:

1. Quote the facts the rule names, from the request and the usage list.
2. Take the verdict and the action the rule names for those facts.

The verdicts are input for quality assurance. There is no overall verdict and no judgement of the
change's effect on quality.
