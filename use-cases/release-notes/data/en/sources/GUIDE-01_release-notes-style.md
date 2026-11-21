---
id: GUIDE-01
title: How to write release notes (Yamagara Time)
updated: 2026-06-01
owner: Yamagara Soft Co., Ltd., Product Department
---

# GUIDE-01 How to write release notes

One set per release, for the users of Yamagara Time (employees, attendance administrators and
developers of integrations).

## 1 Groups and order

Group the PRs by label, in this order. Leave out a group with no items.

| Label    | Group                          |
| -------- | ------------------------------ |
| breaking | Important compatibility notice |
| security | Security                       |
| feature  | New features                   |
| bug      | Bug fixes                      |

- 1.1 PRs labelled `internal` or `docs` do not affect users and are not listed.
- 1.2 A PR with several labels goes in the group highest in the table.

## 2 Writing an item

- 2.1 Say in one sentence what changes for the user, and end with the PR number, such as (#481).
- 2.2 Never name staff, branches or development jargon.
- 2.3 A compatibility item says what the user must do (where to migrate, for example).
- 2.4 Never write an effect the PR does not state (faster, for example) or a future plan.

## 3 Heading

- 3.1 The document heading is "Yamagara Time <version> release notes".
- 3.2 Write the release date under the heading when it is decided. When it is not, leave it out.
