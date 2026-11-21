---
name: expense
description: How to judge each line of an expense claim against the travel and expense policy in `expense/standards/` (EXP-01 to EXP-06) as OK, caution (要注意) or NG, with a suggested fix.
---

# Checking an expense claim against the policy

The policy is six items, one file each in `expense/standards/`: `EXP-01` lodging, `EXP-02`
transport, `EXP-03` taxi, `EXP-04` meeting and entertainment meals, `EXP-05` receipts, `EXP-06` personal
expenses. Each file's rule says which line is `OK`, which is caution (`要注意`) and which is `NG`.
Apply the rule as written; it is the company's decision, not yours.

For each line:

1. Check `EXP-05` first: a receipt is attached, and the amount claimed equals the receipt amount,
   compared digit by digit as the claim gives them.
2. Find the item for the line's category and description: lodging (`EXP-01`), a train or plane
   (`EXP-02`), a taxi (`EXP-03`), a meeting or entertainment meal (`EXP-04`), something personal or
   for family (`EXP-06`).
3. Compare the line with that rule, using only the line's own fields: the amount, the seat class in
   the description, the prior approval number, the attendees and the remarks. A limit is compared
   with the amount as written; do not divide or add up amounts.
4. A line that breaks two items gets the stricter verdict, citing the item that decides it; mention
   the other in the reason. A line that breaks none is `OK`, citing the item for its category.

For caution and `NG`, the suggested fix follows the item's example fix. For `OK`, leave it empty.
A remark is context for the approver, never a reason to change a verdict.
