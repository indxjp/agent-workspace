---
changelog: platform
section: Added
---

- A skill script can import the built-in table reader by its package path,
  `@indx-workspace/builtin-skills/office-reader/scripts/lib/table.mjs`. It reads a CSV (strict
  RFC 4180) or an `.xlsx` sheet into typed rows, with whole, decimal and date columns, and refuses a stray
  quote, a row of the wrong width, an unreadable number, an `.xlsx` error cell, a number that is only
  part of a merged range or a date cell outside a `date` column, naming the row, the column and the
  value. Its companion `lib/cli.mjs` parses the script's arguments and prints the result or a typed
  refusal. `run_skill_script` resolves the package path to the placed `office-reader` skill, so the
  same import works in the repository and in a run. It refuses a skill that is not byte for byte
  the shipped one (ADR-0173).
- office-reader's `.xlsx` output lists each sheet's date-formatted cells (`dates`) and error cells
  (`errors`), and says whether the workbook uses the 1904 date system (`date1904`). An error cell's
  value is now the error's text (`#DIV/0!`) instead of `null`.
