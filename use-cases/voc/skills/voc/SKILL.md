---
name: voc
description: How the monthly voice-of-the-customer report groups enquiries and reviews into improvement themes, and what it leaves out.
---

# The exports

The `voc` folder holds two CSV exports, in Japanese under `voc/ja/` and in English under `voc/en/`:

- The helpdesk's enquiries (`問い合わせ_<YYYY-MM>.csv` / `enquiries_<YYYY-MM>.csv`): one row per
  enquiry, with its id (`Q-xxxx`), the date received, the channel, the product, the subject, the
  body, and the customer's name, email and phone.
- The store's reviews (`レビュー_<YYYY-MM>.csv` / `reviews_<YYYY-MM>.csv`): one row per review,
  with its id (`R-xxxx`), the date, the product, the rating (1 to 5), the text and the reviewer's
  nickname.

Take only the rows dated in the report's month; an export may hold a row from the month before.

# Themes

A theme is one thing customers say about one product or one part of the service (a leaking
spout, a hard-to-follow manual, crushed boxes), named in a few words. Group the enquiries and the
reviews of the month together:

- A theme needs at least two items, enquiries and reviews counted together. An item that shares
  no theme goes under **Other**, with its id only.
- `issue` themes are problems to fix; `praise` themes are what customers like. List the `issue`
  themes first, then the `praise` ones.
- Each theme has a one-sentence summary in your own words, an improvement to consider (for an
  `issue`: what the team responsible could look at, such as the spout's seal or the manual's timer
  page; for `praise`: what to keep), and the ids of every item in it.

Never state a cause the items do not give, and never invent an item, a number or a product.

# What the report never holds

The report names items by id only. Never copy a customer's name, email address or phone number,
or a reviewer's nickname, into the report or the typed answer, even when asked: the support team
finds them by the id in the helpdesk.

# The file

One Markdown file, `voc-reports/<YYYY-MM>_voc.md`, in the language of the request: a heading with
the month, one `##` section per theme (summary, improvement, the ids), then **Other**.
