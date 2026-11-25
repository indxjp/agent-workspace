---
name: glossary
description: How to judge each term of the company glossary in `glossary/standards/` against a document (OK, caution or NG), with the preferred term as the fix and the glossary row cited.
---

# Checking terms against the glossary

The glossary is a CSV export, one row per term. The Japanese file's columns are
`id, 推奨語, 使わない語, 扱い, 定義, 備考`; the English file's `id, preferred, avoid, rule,
definition, note`. Terms to avoid are separated by `／` or ` / `. Judge the document row by row:

- `OK`: the document uses only the preferred term for this concept, or does not use the concept at
  all (say "not used" / 「使用なし」 in `Where`).
- `NG`: the document uses a term to avoid and the row's rule is `置き換える` / `replace`. The fix is
  the same sentence with the preferred term.
- `要注意` / `caution`: the document uses a term to avoid and the rule is `文脈で判断する` /
  `judge by context`. Read the note: when the use is the exception it names (a label quoted from the
  screen, an alarm device), say so in `Why`; otherwise suggest the preferred term as the fix. The
  writer decides.

Match whole words as the document writes them, including headings; a term inside a longer product
or button name the glossary does not list is not a use. Quote the document's own words, give the
heading each one is under, and count every place, not only the first. When one row's term appears
both correctly and wrongly, the verdict follows the wrong use.
