---
name: deal-risk
description: When an open deal counts as stalled or at risk, and how the weekly report is laid out.
---

# The CRM export

The files in the `deal-risk` folder are a CRM's CSV export, joined by `opportunity_id`.

- `opportunities.csv`: one row per deal, with its `account`, `name`, `owner`, `stage`, `amount`,
  `close_date`, `days_in_stage`, `days_since_activity` and `next_step`. The CRM computes the two
  day counts when it exports. A deal is open unless its `stage` is `Closed Won` or `Closed Lost`
  (受注 / 失注 in the Japanese export).
- `activities.csv`: `activity_id, date, opportunity_id, type, owner, summary`, one row per call,
  visit or email logged on a deal.

# The rules

- **Stalled**: `days_since_activity` is 14 or more, or `days_in_stage` is 45 or more.
- **At risk**: a logged activity says the decision maker leaves or changes, a competitor enters,
  the budget is cut or put off, or the customer has not replied after a follow-up; or `close_date`
  is before the report date while the deal is still open. A quiet deal with no follow-up logged is
  for the stalled rule to judge, not a risk sign.
- A deal with both is **at risk**, and its evidence names both. A deal with neither is left out.

The evidence quotes the export: the numbers as the columns hold them, and each activity in one line
with its date. Never compute a number the export does not hold.

# The next step

One step for the owner that answers the evidence. Take the deal's `next_step` when it does; else
write one that follows from the evidence and say it is a suggestion. Never promise a price, a date
or a discount.

# The file

One Markdown file, `deal-risk-reports/<date>.md` (`<date>-<owner>.md` when narrowed to one owner), in the language of the request: a `#` heading with the
report date, then one `##` section per flagged deal (at-risk deals first): the account and deal,
the owner, the risk, the evidence as a list, the next step and the sources as `file#id` (for
example `activities.csv#ACT-3003`).
