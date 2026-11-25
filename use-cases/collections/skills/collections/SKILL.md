---
name: collections
description: Which invoices the collections list holds, the reminder stage of each, how a reminder is drafted, and how the list is laid out.
---

# The receivables export

`receivables.csv` in the `collections` folder is the accounting system's CSV export of open and
recent invoices, one row per invoice: `invoice_id, customer, invoice_date, due_date, amount,
balance, days_overdue, billing_contact, contact_email, last_reminder, memo`. `balance` is what is
still unpaid; the system computes `balance` and `days_overdue` when it exports (0 when the invoice is
not yet due).

# Which invoices to list, and their stage

List an invoice when `balance` is more than 0 and `days_overdue` is 1 or more. Leave out a paid
invoice (`balance` 0) and one not yet due (`days_overdue` 0), whatever its memo says.

| `days_overdue` | Stage                             | Draft                                    |
| -------------- | --------------------------------- | ---------------------------------------- |
| 1 to 14        | `first-reminder` (一回目の督促)   | a polite reminder email to the contact   |
| 15 to 44       | `second-reminder` (二回目の督促)  | a firmer email asking for a payment date |
| 45 or more     | `escalate` (経理責任者へ引き継ぎ) | a note for the finance manager, no email |

A part payment keeps the invoice on the list with its `balance`. Quote `amount`, `balance`,
`due_date` and `days_overdue` exactly as the export holds them; never add invoices up or compute a
new figure.

# The draft

- A reminder email goes to `billing_contact` at `contact_email`, in the language of the request. It
  names the invoice id, the due date and the balance, and asks the customer to check the payment
  (first reminder) or to tell us the date they will pay (second reminder). It never offers a new
  due date, an instalment plan, a waiver or a discount, and never threatens.
- A note for the finance manager gives the invoice, the balance, the days overdue and what the memo
  says so far (reminders sent, what the customer said). The manager decides what happens next.

# The file

One Markdown file, `collections-reports/<date>.md` (`<date>-<invoice id>.md`, the customer's first `invoice_id`, when narrowed to one
customer), in the language of the request: a `#` heading with the report date, then one `##`
section per listed invoice, most overdue first, each with the customer, the invoice, the due date,
the balance, the days overdue, the stage, the draft and the source as `file#id` (for example
`receivables.csv#INV-7301`).
