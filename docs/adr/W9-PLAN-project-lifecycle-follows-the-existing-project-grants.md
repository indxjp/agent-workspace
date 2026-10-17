# ADR-W9-PLAN — Project lifecycle follows the existing project grants

Status: accepted
Date: 2026-09-12
Decided by: the Wave 9 orchestrator, at W9.7 pre-flight
Scope: the `W9-PROJ-124` minimum implementation and verifier attack; existing project RBAC

## Context

The `W9-PROJ-124` card said archive and restore were authorised for "Owner/Admin and the project's
creator". The landed policy does not grant Admin a workspace-wide `projects` capability. Owner has
the `any` fallback, Builder has `projects: own`, and Admin falls back to `none`. Project routes call
`requireProjectAccess` with the persisted creator, so a non-Owner is authorised only when the role
and ownership grant both permit the operation.

Issue #124 asks for owner/creator authorisation. The task does not own
`apps/web/server/rbac/permissions.ts`, and widening Admin here would be a repository-wide policy
decision rather than a project-lifecycle implementation detail.

## Decision

Archive and restore are authorised for the workspace Owner or the project creator when the
existing role policy grants that creator access. In the current policy this admits an owning
Builder and refuses a non-creator Builder or Admin. Cross-workspace and refused identifiers retain
the same concealed not-found shape as nonexistent identifiers.

The verifier attacks both non-creator roles explicitly and proves that creator and workspace-Owner
paths succeed. No client-side role table is added.

## Alternatives rejected

- **Grant Admin project management in this task.** Rejected because the card owns no policy file
  and the issue does not require a general Admin projects grant.
- **Special-case Admin inside the lifecycle handler.** Rejected because bypassing
  `requireProjectAccess` would create a second, route-local policy.

## Consequences

The lifecycle UI follows server outcomes and persisted creator facts. A future product decision to
grant Admin project management belongs in a separately owned RBAC change and would automatically
flow through the same server access helper.
