---
changelog: platform
section: Changed
---

- The budget use case (AN) reads its export with office-reader's built-in table reader and command
  line (ADR-0173) instead of its own CSV parser. Its numbers on the shipped exports are unchanged.
  It now also computes an `.xlsx` export (the first sheet) and reads a quoted `"1,000"` as 1000. It
  refuses an error cell, a date-formatted cell and an amount in merged cells instead of guessing,
  and prints a refusal as `{ error, message, row?, column?, value? }` on stderr with exit code 1 (2
  for an unknown option, an option with no value, a threshold that is not a percent or a wrong
  number of files). The month column must be text (`2026-09`): a month Excel stored as a date is
  refused, and the agent asks for that column as text. The AN template's skill and instructions
  describe the same contract, so a new AN entry starts on the reader.
