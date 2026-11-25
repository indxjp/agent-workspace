---
name: competitor
description: How the competitor comparison table is checked against the competitors' public releases, and how the weekly report of changed rows is laid out.
---

# The sources

- `competitor/comparison.csv`: the team's comparison table. One row per competitor and item, with
  its `row_id` (`C-01`), `competitor_id` (`UKG`), `competitor`, `item`, `value`, the `source`
  release it was taken from and the date it stands `as_of`.
- `read_competitor_news`: the competitors' public releases. Each record has its `id`
  (`UKG-003`), `source`, `url`, `title`, `summary`, `publishedAt`, and `fields`: `competitor` (the
  id), and, when the release changes a table item, `item`, `value` and `effectiveDate`. The
  answer's `asOf` is the date the snapshot stands as of.

# What counts as a change

A row changes when a release of the same `competitor` names the same `item` (in either language),
its `value` differs from the row's `value`, and it was published after the row's `as_of` and on or before the report date (a release published
later belongs to a later report). The row's
value before and the release's value after are quoted exactly; when the release has an
`effectiveDate` after the report date, say from when the new value applies.

A release published after the report date is left out. A release that names no table item (an
event, an announcement) changes no row: list it under
"other releases" with its title and date only. A release that confirms the value a row already
holds changes nothing and is not listed. Never infer a change from a summary's tone, and never
compare prices or say which is cheaper: the table shows each value, a person compares them.

# The file

One Markdown file in the language of the request:

1. A `#` heading with the report date, then the line 「この比較は 2026-11-20 時点の公開情報のスナップショットに
   基づきます。」 / "This comparison is based on a snapshot of public releases as of 2026-11-20."
   (with the answer's `asOf`).
2. **Changed rows** (`変更のある行`): a table with the header `行, 競合, 項目, 変更前, 変更後, 根拠, 公表日` /
   `Row, Competitor, Item, Before, After, Source, Published`, one line per changed row.
3. **Other releases** (`その他の発表`): one bullet per release that changes no row.
