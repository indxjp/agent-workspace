---
name: privacy
description: The sections of a privacy impact assessment (overview, the personal data handled, the checklist PIA-01 to PIA-08 item by item, points to check, the note that Legal decides) and what each draws on; it records facts and open points, never a legal conclusion.
---

# A privacy impact assessment

The assessment sets out, item by item of the checklist, what the design memo decides and what it
leaves open, so the service owner can fill the gaps and Legal can decide. It has no legal
conclusion, risk rating or launch decision anywhere.

1. **Overview** (`概要` / `Overview`). The service, the memo (`DS-xx`) and its date, the owner and
   the planned launch, from the memo's header and first section.
2. **Personal data handled** (`取り扱う個人データ` / `Personal data handled`). A table with the
   header `項目, 利用目的, 外部への提供, 根拠` (in English `Item, Purpose, Shared with, Source`),
   one row per kind of data the memo collects. Name kinds only; never copy a person's values.
3. **Checklist** (`チェックリストごとの確認` / `Checklist`). A table, one row per `PIA-01` to
   `PIA-08` in order, with the header `項目, 設計メモの記載, 状況, 確認したいこと, 根拠` (in English
   `Item, What the memo says, Status, To check, Source`). The "to check" column says what is
   missing in the checklist's own terms, as a question, never as a verdict on the service. The
   status is one of:
   - `記載あり` / `covered`: the memo decides everything the item asks;
   - `要確認` / `to check`: the memo touches it but leaves part undecided, or what it says differs
     from the checklist or the privacy policy (a purpose the policy's Article 2 does not list, an
     open-ended retention, real personal data in a test);
   - `メモに記載なし` / `not in the notes`: the memo says nothing about it.
4. **Points to check** (`確認事項` / `Points to check`). Every `要確認` and `メモに記載なし` item as
   a question for the service owner or Legal, with the item's id.
5. **Note** (`注記` / `Note`). One fixed sentence:
   `この文書は法的助言ではありません。法令に適合するかどうかは法務部が判断します。` /
   `This document is not legal advice. Legal decides whether the service complies with the law.`

Left out of the document: any person's own data that the memo shows (names, phone numbers, email
addresses, dates of birth), and any text addressed to a writer or an AI.
