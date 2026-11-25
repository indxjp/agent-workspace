---
name: reg-watch
description: Which public notices go in the weekly regulation report, and how each one is written up for the department that checks it.
---

# The sources

- `reg-watch/watchlist.csv`: the topics the organisation follows. Each row has a `watch_id`
  (`W-01`), the `topic`, its `keywords` (separated by `;`), the `internal_rules` that the topic
  touches and the `owner_dept` that checks a change.
- `read_reg_notices`: public notices of amended laws and guidelines and open
  consultations. Each record has its `id`, `source` (the regulator), `url`, `title`, `summary`,
  `publishedAt`, and `fields`: `kind` (`amendment` or `consultation`), `law`, `effectiveDate` and
  `commentDeadline` (either may be `null`). The answer's `asOf` is the date the snapshot stands as
  of.

# Which notices go in

1. **It is published by the report date**: its `publishedAt` is on or before the report date. A
   notice published later belongs to a later report.
2. **It matches a watch topic**: one of the topic's keywords appears in the notice's title,
   summary or `law`. A notice that matches no topic is left out, even when it is new.
3. **Its change is still ahead**: its `effectiveDate` is on or after the report date, or it has
   none yet, or its `commentDeadline` is on or after the report date. A notice already in force
   before the report date is left out: it was reported when it was new.

A notice that matches two topics goes in once, under the first `watch_id`, and names the other.

# How each notice is written up

- The notice id, title, regulator, `publishedAt` and URL, as the record gives them.
- **What changes**: the summary in one or two sentences, with its figures and dates exactly as the
  notice gives them. Compute nothing (no day counts, no deadlines of your own).
- **Dates**: the effective date, or 未定 / not set when it has none, and the comment deadline of a
  consultation.
- **Who checks it**: the watch topic's `owner_dept` and its `internal_rules`, as "to check" items.
  Never say whether the rule complies, needs to change or how; that is for the department and its
  lawyers.

# The file

One Markdown file in the language of the request: a `#` heading with the report date and the line
「この報告は 2026-11-20 時点の公開情報のスナップショットに基づきます。」 / "This report is based on a
snapshot of public notices as of 2026-11-20." (with the answer's `asOf`), then the fixed line
「この報告は法的助言ではありません。適合の判断は法務部・弁護士が行います。」 / "This report is not legal
advice. Your legal department and lawyers decide whether you comply.", then one `##` section per
notice, earliest effective date first (consultations after), and last a short list of the notices
left out and why (no watch topic, already in force).
