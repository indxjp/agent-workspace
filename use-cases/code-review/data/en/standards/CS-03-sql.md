# CS-03 Build SQL with placeholders

- Source: coding standard, rule 3
- Rule: a value goes into SQL through a placeholder (`$1` and so on) and a parameter array, never by string concatenation or a template string.

## Verdict

- OK: values are passed as placeholders, or the diff has no SQL.
- Caution: the SQL is built outside the diff and cannot be read.
- NG: a value is embedded in SQL by concatenation or a template string.

## How to fix

Separate the value into a parameter, as in ``db.query('... WHERE name LIKE $1', [`%${value}%`])``.
