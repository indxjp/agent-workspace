# ADR-FORMAL-P1-principal-kind-has-one-spelling — A principal kind has one spelling, `api-key`

Status: proposed
Date: 2026-09-23
Decided by: formal specification programme, unit P1-synthesis (`er-synthesis`); needs Owner ratification
Scope: `packages/core/src/db/schema/workspace-principals.ts`, `packages/core/src/db/repositories/directory.ts`, a data migration

## Context

`workspace_principals.kind` stores `api_key`, while the wire (`PRINCIPAL_KINDS`) and every other
closed set use kebab case, `api-key`. `api_key` fails `oneOf`'s `SAFE_VALUE`, which is why this is
the only hand-written closed-set check (er-core finding 5), and the server types carry the storage
spelling. `value_gate_diverges_exactly_at` names it as the one closed set that escapes the DDL value
gate.

## Decision

Store `api-key`. Build `workspace_principals_kind_valid` with `oneOf` over
`['membership', 'api-key']` and rewrite the source check (`workspace_principals_source_matches_kind`
in the target) against that spelling. One data migration rewrites the stored value.

## Alternatives considered

- **Keep `api_key` and translate at the boundary.** Today's state: two spellings of one enumeration,
  and a check the value gate cannot vouch for.

## Consequences

- Every closed set of the schema passes the value gate (`unrenderable Target.schema = []`).
- The refinement map respells the value (`AgentWorkspace.Er.Refinement.kindToTarget`); the
  conformance suite pins today's `workspacePrincipalKinds` and fails when the migration lands.
