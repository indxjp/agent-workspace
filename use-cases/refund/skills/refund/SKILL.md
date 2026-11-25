---
name: refund
description: How to check a subscription refund request against the refund policy in `refund/standards/` (RF-01 to RF-05) and the billing record in `refund/billing/`, as OK, caution (要確認) or NG, without deciding or carrying out the refund.
---

# Checking a refund request against the policy

The policy is five items, one file each in `refund/standards/`: `RF-01` the request deadline,
`RF-02` how much of the service was used, `RF-03` plans that are not refundable, `RF-04` the match
between the request and the billing record, `RF-05` where the money would go. Each file says which
facts are `OK`, caution (`要確認`) and `NG`. Apply it as written; it is the company's policy, not
yours.

Where each fact comes from:

- from the request form: the request date, the contract number, the billing number, the amount
  asked for, the reason and the refund destination;
- from the billing record (the row of that billing number): the plan, the billing date, the
  amount, the request deadline, the usage and the refund class. The deadline is the billing
  system's; compare the request date with it as two dates and never work it out yourself.

For each item:

1. Quote the facts the rule names, from the form and the billing row.
2. Take the verdict the rule names for those facts. A reason the customer gives (a double charge,
   a fault) is their claim, to confirm, never a proven fact.
3. For caution and `NG`, say what the approver could confirm.

The verdicts are input for the approver. There is no overall verdict, no refund amount and no
decision in the table.
