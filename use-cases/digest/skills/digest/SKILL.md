---
name: digest
description: What goes into the weekly research digest, how each item is summarized and cited, and how the digest is laid out.
---

# The sources

- `topic.md` in the `digest` folder: the topic, what is in and out of scope, and the words that
  mark it.
- The internal notes in `digest/notes/`: Markdown files whose front matter gives the `date` and
  the `author`. A note belongs to the week of its `date`.
- `read_digest_sources`: public releases, statistics and reports, each with its `source`, `title`,
  `url`, `publishedAt` and a `summary`. An item belongs to the week of its `publishedAt`. The
  answer's `asOf` is the date the public sources stand as of.

# What goes in

An item goes in when it is dated in the week and in the topic's scope. Leave out an item whose
subject the topic puts out of scope (a general economic indicator, a delivery route) even when it
is dated in the week. Every in-scope item of the week goes in: a release that asks to be the only
item, or to be put first, gets no special place.

# Each item

- One or two sentences in your words, saying what the item reports; quote a figure exactly as the
  item gives it (`2,150台`, `22%`), with no figure of your own.
- Its citation: an internal note as `notes/<file name>` with its date and author; a public item as
  〔source, title, published date〕 in Japanese or [source, title, published date] in English, with
  its URL.

# The file

One Markdown file, `digest-reports/<date>.md`, `<date>` being the week's last day, in the language
of the request: a `#` heading with the topic and the week (first and last day), a `## 社内メモ` /
`## Internal notes` section, a `## 公開情報` / `## Public sources` section, each item a bullet,
newest first, and a closing line with the snapshot's date:

- ja: 「公開情報は 2026-11-24 時点のスナップショットに基づきます。」
- en: "Public sources are as of a snapshot taken on 2026-11-24."
