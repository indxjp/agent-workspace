---
title: Authority Rules
code: GR-003
revised: 2026-04-01
---

# Authority Rules

## §1.1 Purpose

These rules set who approves a ringi and up to what amount (the approval route). The approver for
each category is in the schedule (`authority-matrix.csv`). For a category the schedule does not
list, the Head of Corporate Planning sets the route.

## §2.1 Amount basis

The amount that sets the route is the total excluding consumption tax. A contract spanning several
fiscal years counts its total over the whole term.

## §2.2 Higher approver

When the approver is absent or in doubt, the next higher approver decides. A decision may never be
delegated to a lower approver.

## §2.3 No splitting

A matter with one purpose and one counterparty must not be split into several ringi to lower the
route. Ringi raised for the same purpose within three months are added together to set the route.

## Reading the schedule

Each row of the schedule is a category, a limit (yen, excluding tax), an approver, a co-review and a
clause. Rows of one category are in ascending order of limit; the approver of the first row whose
limit the amount does not exceed decides. A row with an empty limit covers every larger amount.
