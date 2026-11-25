---
name: ringi-review
description: How to check a ringi against the ringi rules, the donation rules and the authority schedule in `ringi-review/standards/`, and the `route.mjs` script that reads the schedule.
---

# Checking a ringi before it is circulated

The standards are in `ringi-review/standards/`: the ringi rules (稟議規程, GR-002), the authority
rules (職務権限規程, GR-003) with their schedule `authority-matrix.csv`, and the donation rules
(寄付金取扱基準, GR-011). Check the ringi in this order, one row each:

1. **Required entries** (GR-002 §4.1): every entry the clause lists is filled in. An entry marked
   （未記載） or "(not stated)" is `NG`, one row naming each missing entry.
2. **Quotes** (GR-002 §4.2): for capital investment, outsourcing and IT investment over 1,000,000
   yen, two or more quotes are attached, or the reason for a single supplier is stated. One quote
   and no reason is `NG`. Other categories: `OK`, saying the clause does not apply.
3. **Approval route** (GR-002 §4.4 and the schedule, GR-003): compare the route the ringi states with
   the `approver` and `coReview` that `route.mjs` printed. A different approver, or a missing
   co-review, is `NG`; the fix is the script's route, cited with its `clause` and `standard`.
4. **Donations** (GR-011, only for the category 寄付 / donation): a recipient that is a political
   organisation, a politician's support group, a politician or a religious body is `NG` under
   §2.2; a missing recipient check is `NG` under §2.1.
5. **Budget and early start** (GR-002 §5.1, §5.2): `OK` when the ringi is within budget and starts
   after its planned approval; `caution` when it is unclear.

Write "risk of conflict" (抵触のおそれ) and "needs checking" (確認が必要), never "violation": the
approver decides. Quote the ringi's own words; never infer what the drafter meant.

## The route script

`scripts/route.mjs <authority-matrix.csv> <category> <amount-yen>` prints
`{ category, amountYen, approver, coReview, clause, standard }` for the first row of the category whose limit
the amount does not exceed (an empty limit covers every larger amount). In Japanese the route is
written `<approver>決裁` (with `合議: <coReview>` when there is one); in English `<approver>` (with
`co-review: <coReview>`). It refuses an unknown category or an amount that is not whole yen: say
the route could not be determined and give no verdict for that row.

## Typed output

`standard` is the code and section, such as `GR-002 §4.1`, `GR-003 §3.1` or `GR-011 §2.2`.
