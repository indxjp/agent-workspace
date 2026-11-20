---
title: Data and state
evidence: [packages/core/src/db/schema/runs.ts, packages/core/src/db/repositories/runs/types.ts:26-60, packages/core/src/db/repositories/scope.ts:105-120, docs/architecture.md:362-396, docs/architecture.md:343-360, docs/adr/0153-object-storage-one-key-layout-catalog-first-writes-references-not-bytes.md, migrations, AGENTS.md]
---

<!-- jevlint:diagram data-model -->

### What is stored where

| State | Where | Written by | Read by |
| --- | --- | --- | --- |
| Workspaces, members, agents, versions, sessions, runs, run events, tokens, secrets (encrypted) | PostgreSQL, schema in `packages/core/src/db/schema/` | `packages/core` repositories, called from each domain's `store.ts` | the control plane and the gateway |
| File, skill, attachment and session-state bytes | one object store, chosen by `AW_STORAGE_URL` (`s3://`, `gcs://`, `azblob://`, `file://`) | the storage catalog service only | the catalog service; the runner gets an archive |
| Catalog rows naming those bytes | PostgreSQL (`files`, `skill_revisions`, `session_state_blobs`) | the catalog service | domains, through the catalog |
| A portal app's own records | the app's PostgreSQL schema, through Drizzle in `packages/app/src/db/` | the app kit | the app |
| Process-local state | eight `defineSlot` slots (live runs, trace attributes, driver instances, cron handle, ...) | the process | the process |

### How a save stays consistent

Every save is row-first (ADR-0153). The catalog reserves a `pending` row under a new object id,
streams the bytes to `workspaces/<workspace id>/<area>/<object id>`, then one transaction confirms
the row as `ready` with the measured size and checksum. A replaced or removed row is `deleting`
until its object is gone, and a cleanup job reports or removes what a crash left. Only `ready` rows
are listed, searched or granted, and a rename changes the row alone.

### Runs

A run row's status comes from the closed vocabulary in `packages/contracts/src/runs.ts`. A paused
run (`awaiting_approval`) stores a deadline 24 hours ahead; one unique index allows exactly one
continuation per paused run, and approved tool calls are consumed by one guarded update so each runs
at most once (`docs/architecture.md:597-622`). Usage, tokens and cost are written on the run row
(`RunRecord`: `inputTokens`, `costUsd`, `accountingState`).

### Tenancy

Every repository query is built from `WorkspaceScope.workspaceId`, a value the scope resolver mints
from a lookup. The class keeps a private copy so `isWorkspaceScope` can check an invariant rather
than a shape (`scope.ts:105-120`). Authorisation happens before a workspace-scoped read.

### Lifetimes

Sign-in session cookies last 12 hours, CLI tokens 12 hours, browser tokens 1 to 60 minutes, run
tokens 5 minutes (at most 1 hour), public share links 24 hours to never; bearer secrets are stored
only as SHA-256 hashes. Migrations under `migrations/` are forward-only and expand/contract
(`pnpm migrations:lint`). Demo workspaces, their tokens, admissions and guests are swept when they
expire (`store-demo`).
