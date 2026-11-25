---
name: meeting-prep
description: How a one-page meeting brief is put together from the CRM export.
---

# The CRM export

The files in the `meeting-prep` folder are a CRM's CSV export, one row per record, joined by
`account_id`.

- `meetings.csv`: `meeting_id, date, start, end, subject, account_id, attendees, owner`.
  `attendees` is separated by `;`.
- `accounts.csv`: `account_id, name, industry, owner, notes`.
- `opportunities.csv`: `opportunity_id, account_id, name, stage, close_date, next_step`. A deal
  is open unless its `stage` is `Closed Won` or `Closed Lost` (受注 / 失注 in the Japanese export).
- `emails.csv`: `email_id, date, account_id, from, to, subject, summary`.

# One brief per meeting

A brief fits on one page, in this order:

1. **Meeting**: the subject, the time and the attendees, as the calendar has them.
2. **Account notes**: what `accounts.csv` says about the account, in a few lines.
3. **Open deals**: each open deal with its stage and next step. Leave out closed deals.
4. **Recent emails**: the account's three latest emails, newest first, each in one line.
5. **Talking points**: two or three points that follow from the notes, deals and emails, each
   naming the row it follows from. A point never states a fact the export does not hold.

Every line names its source as `file#id` (for example `opportunities.csv#OPP-0102`).

# The file

The day's briefs are one Markdown file, `meeting-prep-reports/<date>.md`, in the language of the
request. Each meeting is one page: a `#` heading with the time and the account name, the sections
above as `##` headings, and a `---` line before the next meeting's page.
