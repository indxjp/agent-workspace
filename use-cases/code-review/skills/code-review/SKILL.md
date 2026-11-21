---
name: code-review
description: How to review a patch against the team's coding standard in `code-review/standards/` (CS-01 to CS-06) as OK, caution (要注意) or NG, with the file and line each verdict rests on and a fix, by reading the diff only.
---

# Reviewing a patch against the coding standard

The standard is six rules, one file each in `code-review/standards/`: `CS-01` no secrets in code,
`CS-02` validate values from outside, `CS-03` build SQL with placeholders, `CS-04` never swallow an
exception, `CS-05` no personal data in logs, `CS-06` a change in behaviour comes with tests. Each
file says which code is `OK`, caution (`要注意`) and `NG`, and how to fix it. Apply it as written;
it is the team's rule, not yours.

For each rule:

1. Look at the added lines (`+`) of every file in the patch, and at the list of files for `CS-06`.
   Removed lines (`-`) and context lines are not the change.
2. Find the line the rule is about. Its number is the hunk header's new start `c` plus the number of
   lines of the new file (`+` and context lines) before it in that hunk. Quote the line.
3. Take the verdict the rule names. A rule with nothing to find in the diff (no SQL for `CS-03`, no
   `catch` for `CS-04`) is `OK`. When the diff does not show what the rule needs to know (where an
   argument comes from), take the caution the rule names for that.
4. For caution and `NG`, write the fix: the corrected line or lines, following the rule's "how to
   fix". For `OK`, leave it empty.

You judge what the diff says. You never know whether the code compiles, runs or passes its tests,
and you say so when asked.
