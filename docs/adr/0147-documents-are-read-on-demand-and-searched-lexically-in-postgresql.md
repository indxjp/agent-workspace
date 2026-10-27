# ADR-0147 — Documents are read on demand and searched lexically in PostgreSQL

Status: accepted
Date: 2026-10-18
Decided by: the Owner (issue #1310, approved 2026-10-18; tracker #1273, unit P8-0)
Scope: `docs/spec.md` §3, §16 and §38; amends spec §3, §16 and §38

## Context

The spec closes off document handling in three places:

- §3 lists `vector databases`, `RAG pipelines` and `document extraction pipelines` under "Specifically
  avoid adding", unless absolutely necessary for the Claude Agent SDK runtime itself.
- §16 says "Do not build RAG.", "Do not automatically create embeddings." and "Do not create an
  indexing pipeline.", and describes files as plain workspace files reached through the SDK's file
  tools.
- §38 lists `RAG`, `embeddings` and `vector search` as non-goals.

Read literally, these rule out reading the text of a PDF, a spreadsheet or a Word file, and rule out
searching across files. The SDK feature gallery (tracker #1273, phase P8) has cells for document
parsing and search that cannot honestly reach "supported" while the spec says no. A spec non-goal
changes by an explicit decision, never by a quiet feature. This record is that decision. The Owner
approved it on issue #1310.

## Decision

The non-goals stay, with one narrow, named exception. Five rules bound it.

1. **Extraction is on demand.** A file's text is extracted when a caller asks for it: an agent tool
   or an API request. Nothing runs on upload. No background job or queue processes every file.
2. **Search is lexical PostgreSQL full-text search** (`tsvector` / `tsquery`) over text that
   on-demand extraction already produced. Storing that text and its `tsvector` in PostgreSQL is a
   cache of work a caller asked for. It is not an ingestion pipeline.
3. **Still excluded:** embeddings, vector columns and extensions (for example pgvector), vector
   databases, external search or extraction services, and RAG orchestration, meaning retrieval
   injected into prompts automatically. Files remain workspace files that the SDK's file tools can
   read.
4. **Scope is unchanged.** Extracted text and search results obey the tenant, workspace and RBAC
   rules of the file they came from. A session proves identity, RBAC proves permission, a repository
   scope proves tenant selection; search is no shortcut around any of them.
5. **Mechanism is out of scope here.** Parsers, supported formats, schema, size limits and API shape
   belong to units P8-1 to P8-5, each with its own review.

The spec carries the same exception next to each prohibition it qualifies (§3, §16, §38). No original
prohibition sentence is removed, and no heading is added.

## Alternatives considered

- **Delete the non-goal lines.** Rejected. It would widen scope to RAG and embeddings, against the
  v1 rule of no vector search.
- **Record the decision here only and leave the spec unchanged.** Rejected. The spec would keep
  calling extraction and search non-goals while the code did both.
- **Embeddings or a vector store for semantic search.** Rejected for v1. It adds an extension or a
  service, a model dependency and a retrieval layer. Lexical search covers the need without any of
  them. A later decision may revisit it in its own ADR.
- **An external search or extraction service.** Rejected. It adds a deployment dependency and sends
  tenant files to a third party, against the self-hosted, PostgreSQL-only baseline.
- **Extract and index every file on upload.** Rejected. That is the ingestion pipeline §16 forbids.
  It also spends work on files nobody reads.
- **Keep the non-goals as they are and show the cells as a product ceiling.** Rejected by the Owner's
  approval.

## Consequences

- P8-1 to P8-5 can add on-demand extraction and lexical search without contradicting the spec.
- Any embeddings, vector column or store, external service, upload-time processing or automatic
  prompt retrieval still needs a new ADR.
- `packages/core/src/db/schema/files.ts` quotes §16's "Do not build RAG" sentences. Those sentences
  are unchanged in the spec, so the quote stays accurate.
- Extracted text stored for search is tenant data. The units that add it must cover deletion and
  retention with the file, and must discard or refresh it when the file's content changes.

## Amendment — a run may narrow its file grants (issue #1539)

Rule 4 says search obeys the scope of the file it came from. A run's `file_grants` snapshot is the
whole of that scope, and until now it was the agent's grants, so an agent serving many callers
searched all of their documents. `runs.start` now takes an optional `fileScope`.

1. **The snapshot is the agent's grants narrowed by `fileScope`.** Built-in `search_files` and the
   files hydrated into the sandbox cover only that set. With no `fileScope` nothing changes.
2. **A scope never widens.** Each path must be a canonical path equal to a granted file or inside a
   granted folder. A path that names a parent of a granted file, an unrelated path, or any path for
   an agent with no files fails the run with `403 run_file_scope_not_granted`. Like
   `policy_cannot_widen`, it is judged when the run launches, in the same place the grants are
   resolved, so the start answers `202` and the run fails with the code.
3. **The approval continuation inherits the snapshot.** A run that paused for approval was already
   narrowed. Its continuation is launched with the paused run's `file_grants` as its scope, so
   approving a call cannot restore a path the first run was denied.
4. **The scope belongs to one run.** It is not stored on the session or the agent. A caller that
   serves several people passes each one's paths on each run, and does not share a session between
   them.

`fileScope` is a request-time narrowing only. It adds no index, no per-caller copy of a file and no
new storage.
