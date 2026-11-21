---
name: screening
description: How to search the public restricted-party lists for every name in a counterparty registration request, and how to judge each item of the procedure (SCR-01 to SCR-04) as no match, review or match for a person to resolve.
---

# Screening a registration request

The procedure is four items, one file each in `screening/standards/`: `SCR-01` the company itself
(its name, former names and trade names), `SCR-02` officers and beneficial owners, `SCR-03` the
parent company and major shareholders, `SCR-04` the end user and the ship-to address. Each file
says which names of the request it covers.

## Searching

`check_public_lists` keeps a record when its text holds the query, case ignored. A query is one
piece of text, so search each name several ways and keep every record any of them finds:

- the full name as the request writes it, then without its legal suffix (`株式会社`, `Ltd.`,
  `LLC`, `FZE`, `JSC`, `Holdings`);
- the most distinctive word on its own (for `Kestrel Orbital Holdings`, `Kestrel`);
- for a person, the family name on its own, in romaji and in katakana; katakana spellings vary
  (`ヴァ` and `ワ`, `ー` or none), so search the romaji too;
- the country or city of an address on its own, to see every record there.

## Judging

For each item, compare every record found with the name it was found for:

- `一致` / `match`: the record's name or one of its aliases is the same name, and nothing in the
  request (country, date of birth, address) contradicts it.
- `要確認` / `review`: a record shares a distinctive word, a transliteration or an alias with the
  name, but differs in suffix, spelling, entity or country, or the request lacks what would tell
  them apart (a date of birth, an address). Say what the reviewer should compare.
- `一致なし` / `no match`: every way of searching every name of the item found no record.

An item takes the strongest verdict of its names. Quote the record's `id`, `source` and the alias
or field that matched. Every verdict holds for the lists in the snapshot and its `asOf` date only.

## What the report never says

The report records what was searched and found. It never says the party is cleared, safe, approved
or rejected, never recommends doing business or not, and never gives legal advice. A person in
compliance resolves each `要確認` and `一致` and decides.
