---
name: trend
description: Which public news articles and posts go in the morning digest, and how each one is written up for the team that follows its topic.
---

# The sources

- `trend/topics.csv`: the topics the organisation follows. Each row has a `topic_id` (`T-01`), the
  `topic`, its `keywords` (separated by `;`) and the `team` that follows it.
- `read_public_news`: public news articles and organisations' public posts. Each record has its
  `id`, `source`, `url`, `title`, `summary`, `publishedAt`, and `fields.kind` (`news` or `post`).
  The answer's `asOf` is the date the snapshot stands as of.

# Which items go in

1. **Its date**: published on the digest date or the day before. An item published after the
   digest date is left out (it belongs to a later digest).
2. **Its topic**: one of the topic's keywords appears in the title or the summary. An item that
   matches no topic is left out. An item that matches two topics goes in once, under the first
   `topic_id`, and names the other.

# How each item is written up

- The headline in the language of the request (the part of the title before or after `/`), the
  publisher (`source`), whether it is news or a post, `publishedAt` and the URL.
- **What it says**: the summary in one or two sentences, with its figures exactly as the item gives
  them. Never add a figure, a cause, a forecast or a judgement of your own.
- **For**: the topic and the team that follows it.

# The file

One Markdown file in the language of the request: a `#` heading with the digest date and the line
「このダイジェストは 2026-11-21 時点の公開情報のスナップショットに基づきます。」 / "This digest is based on a
snapshot of public sources as of 2026-11-21." (with the answer's `asOf`), then one `##` section per
topic in `topic_id` order with its items newest first, a topic with no item saying so in one line.
