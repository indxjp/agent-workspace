# ADR-FORMAL-P1-one-owner-vocabulary — Every owned row names its owner `owner_principal_id`, and attribution is by principal

Status: proposed
Date: 2026-09-23
Decided by: formal specification programme, unit P1-synthesis (`er-synthesis`); needs Owner ratification
Scope: `packages/core/src/db/schema/shares.ts`, `packages/core/src/db/schema/invitations.ts`, `packages/contracts/src/shares.ts`

## Context

`docs/sdk/04-api-specification.md` §2: "_every row that can be "own" or "other" (…, shares) carries
`ownerPrincipalId`_". Every owned table names its owner `owner_principal_id` except `shares`, which
says `publisher_principal_id`, and `ShareResource` carries neither (publication finding 2). The
legacy human attribution (`created_by`, `invited_by`: user ids) sits beside the owner on most
tables; `invitations.invited_by` is the one creator column with no principal beside it (identity
finding 8). `owner_columns_diverge_exactly_at` names `shares` as the only divergence.

## Decision

- Rename `shares.publisher_principal_id` to `owner_principal_id` (and its key to
  `shares_owner_principal_workspace_fk`); expose `ownerPrincipalId` on `ShareResource`.
- Add `invitations.invited_by_principal_id`, tenant-paired `NO ACTION` with a single-column
  `SET NULL` sibling, and keep `invited_by` as display attribution.
- The glossary fixes the vocabulary: **owner** (the principal authorisation compares), **creator**
  (legacy display attribution), **minter** (browser tokens), **label** (display).

## Alternatives considered

- **Keep "publisher" and document it as the share's owner.** A docs fix only; the vocabulary stays
  split and SDK callers still cannot tell their own shares from others'.

## Consequences

- `owned_row_has_exactly_one_owner` then reads one column name for every owned resource.
- The invitation migration derives the principal from the inviter's membership
  (`AgentWorkspace.Er.Refinement.principalOfUser`); an inviter who has left gets `NULL`.
