# CS-05 No personal data in logs

- Source: coding standard, rule 5
- Rule: a log carries ids at most. Never log an email address, a phone number or a name.

## Verdict

- OK: the logs carry only ids or counts, or the diff has no log.
- Caution: a value that may hold personal data, such as a search term, is logged.
- NG: an email address, a phone number or a name is logged.

## How to fix

Log the row's id (`invoiceId`, for example) instead of the personal data.
