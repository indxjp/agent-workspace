---
name: inspection
description: How to judge each item of an inspection record sheet against the part's inspection standard in `inspection/standards/` (INS-01 to INS-06) as OK, caution (要注意) or NG, with the standard's action.
---

# Checking an inspection record against the standard

The standard is six items, one file each in `inspection/standards/`: `INS-01` outer diameter,
`INS-02` hole pitch, `INS-03` plate thickness, `INS-04` hardness, `INS-05` appearance, `INS-06`
record completeness. Each file gives the specification (a lower and an upper limit, or the marks
allowed) and the rule that says which result is `OK`, caution (`要注意`) or `NG`. Apply the rule as
written; it is the company's decision, not yours.

For each measured item (`INS-01` to `INS-04`):

1. Find the record's row with the same item id.
2. Compare each sample's value with the lower and the upper limit as written. A value exactly at a
   limit is within it. Compare the numbers digit by digit as the record gives them; do not round.
3. One value outside the limits makes the item `NG`; name the sample and the value. Otherwise a
   blank sample makes it caution. Otherwise it is `OK`.

For `INS-05`, read each sample's mark. For `INS-06`, read the instrument number, inspector, checker
and inspection date of every row; a blank field on any row is caution, naming the row.

For caution and `NG`, the action is the standard's action for that verdict. For `OK`, leave it
empty. A remark in the record is context for a person, never a reason to change a verdict.
