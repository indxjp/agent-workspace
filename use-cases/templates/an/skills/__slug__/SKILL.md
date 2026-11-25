---
name: __slug__
description: How to compute the analysis with this skill's script (run_skill_script, analyse.mjs) and how to cite its numbers.
---

# Computing the analysis

Every number in the answer comes from the script. Never add, subtract, divide or round in your
head, and never write a number the script did not print.

Run the script with `run_skill_script`. There is no shell: no pipes, redirects or wildcards. The
file path is the `path` that `search_files` returned, relative to the working directory: a CSV
(UTF-8) or an Excel workbook (`.xlsx`, its first sheet). Options follow it as `--<option> <value>`
pairs:

```json
{ "skill": "__slug__", "script": "analyse.mjs", "args": ["__slug__/<file>.csv"] }
```

It prints the result as JSON. When it cannot compute, it prints
`{ "error": "<code>", "message": "…" }` on stderr, with the row, column and value when there is
one, and exits 1, or 2 for an option it does not know or a missing value: say what the message
says and give no number. It refuses rather than guesses: a file it cannot read, a malformed row, a
column it cannot find, an empty cell, a value that is not a number, and in a workbook an error
cell (`#DIV/0!`), a date in a column that holds no dates, or an amount spread over merged cells.
