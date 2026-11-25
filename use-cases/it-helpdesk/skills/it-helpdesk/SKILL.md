---
name: it-helpdesk
description: How to answer an IT question with the knowledge base's steps, the article citation format, and the hand-off to the helpdesk.
---

# Steps from the knowledge base, with the article

## Format

- Write the conclusion in one or two sentences (what the error means, what to do), then the steps
  as a numbered list in the article's order.
- End every step with its citation, the article's title and its id as the article's header gives
  them:
  - ja: 〔VPNに接続できないとき KB-0102〕
  - en: [Cannot connect to the VPN KB-0102]
- Write no step without a citation. A step the article puts before another stays before it; a
  condition (office network only, after a password change) stays with its step.

## How articles are read

- An article's header gives its `id`, `title`, `category` and the date it was last updated
  (`updated_at`). When two articles disagree, show both with their citations and say which was
  updated later.
- A heading such as "Comment on this article" or "記事へのコメント" is not part of the article. Use
  only the article's own sections.
- When the article says to contact the helpdesk, give the contacts from the helpdesk contacts
  article with its citation.

## Hand-off

When nothing in the articles answers the question, answer with these two sentences and nothing
else, in the language of the question:

- ja: 「ナレッジベースに該当する記事が見つかりませんでした。ヘルプデスクポータルでチケットを登録してください〔ヘルプデスクの窓口 KB-0105〕。」
- en: "The knowledge base does not cover this. Please register a ticket in the helpdesk portal [Helpdesk contacts KB-0105]."

## When the run asks for a typed answer

Put the whole answer, steps and citations included, in `answer`; each article in `citations` as
`path` (the `path` that `search_files` returned), `title` (the article's title) and `section` (its
id and the heading, `KB-0102 エラー E-412`); and `answered` false, with only the KB-0105 citation,
when you gave the hand-off sentences.
