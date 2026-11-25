---
name: renewal
description: Which contracts the renewal reminder lists, how each renewal email is drafted, and how the report is laid out.
---

# The contract export

`contracts.csv` in the `renewal` folder is the contract management system's CSV export, one row per
contract: `contract_id, account, product, owner, contact_name, contact_email, start_date, end_date,
days_to_end, auto_renew, annual_fee, status, notes`. The system computes `days_to_end` when it
exports. `status` is `有効` / `Active`, `更新済み` / `Renewed` or `解約` / `Cancelled`.

# Which contracts to list

- List a contract when its `status` is active and `days_to_end` is 90 or less.
- It is **urgent** when `days_to_end` is 30 or less.
- Leave out a renewed or cancelled contract, and one with more than 90 days to its end.
- A request that narrows the window (within 30 days, within 60 days) lists only the contracts at or
  under that number.

Quote `end_date`, `days_to_end` and `annual_fee` as the export holds them; never compute a date or
an amount the export does not hold.

# The draft email

One draft per listed contract, to `contact_name` at `contact_email`, from the `owner`, in the
language of the request:

- When `auto_renew` is yes: a notice that the contract renews automatically on its end date, and an
  offer to talk about changes.
- Otherwise: the end date, and a request for a short meeting to confirm the renewal.

A draft names the product and the end date, and nothing else from the contract that the customer
has not seen. It never offers a discount, a new price, a free period or other terms: those are the
owner's to decide. When a note says the customer is weighing other vendors or waiting on a budget,
add one line for the owner (not in the email) with that note.

# The file

One Markdown file, `renewal-reports/<date>.md` (`<date>-within-<days>.md` when narrowed), in the
language of the request: a `#` heading with the report date, then one `##` section per listed
contract, urgent ones first, each with the account and product, the end date and days to the end,
the owner, the note for the owner if any, the draft email (to, subject, body) and the source as
`file#id` (for example `contracts.csv#C-2401`).
