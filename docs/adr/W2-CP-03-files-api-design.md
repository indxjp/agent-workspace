# W2-CP-03 — The files API: an id is an encoded path, and the ObjectStore is reached through `dist/`

Status: accepted
Date: 2026-09-05
Decided by: W2-CP-03 (ObjectStore)
Scope: `apps/web/server/files/**`, `apps/web/app/api/files/**`

## Context

This task's `Owns` globs are `packages/core/src/storage/**`, `apps/web/server/files/**`,
`apps/web/app/api/files/**` — no `packages/core/db/repositories/**` (the `files` metadata table's
repository, which does not exist yet on this branch) and no `packages/core/package.json`. Three
consequences follow, each forcing a decision this ADR records.

## Decision 1 — `:id` is a base64url encoding of the workspace-relative path

`tests/route-inventory.test.ts`'s shape rule requires `/api/<resource>/:id` — one dynamic segment.
A file's natural identifier, its path (`contracts/agreement.pdf`), has a `/` in it and is not that
shape. With no `files` table repository in this task's `Owns` to hand out a database-assigned id
instead, the id is derived from the path: `Buffer.from(path, 'utf8').toString('base64url')`.

Base64url rather than `encodeURIComponent`: a percent-encoded path still contains a literal `/`
once a router decodes it (`contracts%2Fagreement.pdf` → `contracts/agreement.pdf`), and whether an
encoded slash inside one path segment is treated as a segment boundary is exactly the ambiguity
R-15 §1e's percent-encoding discussion is about. Base64url's alphabet excludes `/` entirely, so the
question does not arise. `decodeFileId` round-trips the id back and re-encodes it to confirm the
segment really is one this module minted (`Buffer.from(id, 'base64url')` silently drops characters
it cannot place rather than throwing on garbage input, so a decode that "succeeds" is not enough on
its own — see `file-id.ts` and `file-id.test.ts`'s "rejects a segment this module never minted, even
if Buffer.from tolerates it" case, verified against the concrete counter-example `'A'`, which
decodes to an empty buffer and re-encodes to `''` — a different string). A decoded id that still
fails `key-safety.ts`'s guard (someone crafts a base64url string that decodes to `../../etc/passwd`)
is refused the same way a raw one is, per `docs/adr/W2-CP-03-object-key-safety.md`.

`requireFilePath` reports every one of these as `404`, never `400`: this route mints every id it
will accept, so one that does not decode to something it minted is unknown, not malformed by the
caller — the same distinction `agents/handlers.ts` draws with `requireAgentId`.

## Decision 2 — no `WorkspaceScope` in `ObjectStoreProvider`; `apps/web` reaches `packages/core` via `dist/`

`packages/core/package.json`'s `exports` has `.`, `./db`, `./db/unscoped` and no `./storage` — that
subpath is W2-DB-02's file, not this task's, and adding it is exactly the kind of change absolute
prohibition #6 forbids. `apps/web/server/files/object-store-bridge.ts` is the one file that reaches
`packages/core/dist/storage/index.js` by relative path instead, so every other file in this
directory imports through it.

The first version of both this bridge and `object-store.ts` reused `@agent-workspace/core/db`'s
`WorkspaceScope` for tenant scoping — the "before hand-rolling a decision procedure, check whether a
dependency you already have makes it for you" rule this repository states. It was reverted after
reproducing the failure it caused: `apps/web`'s own code reaches `@agent-workspace/core/db` by the
package specifier (resolved through `exports` to `dist/`), while this bridge — with no `./storage`
export available — reached `packages/core/src/storage` by a relative path (resolved by Next's
Turbopack straight from source). Those two `WorkspaceScope` values were **two different module
instantiations of the same class**. `WorkspaceScope`'s run-time brand check is a `#private` class
field, which is scoped to the instantiation that declared the class, not to the source text — so a
scope minted by the `dist/`-loaded resolver and handed to the `src/`-loaded `forScope` was refused
by `ForgedWorkspaceScopeError`, reproduced running this task's own
`apps/web/server/files/handlers.test.ts` and `routes.test.ts` before the fix. Full detail and the
transcript's shape are in `object-store.ts`'s own header and in
`docs/adr/W2-CP-03-object-key-safety.md`'s sibling reasoning.

Two changes closed it, and either alone would have been sufficient — both were made, for different
reasons:

* `ObjectStoreProvider.forWorkspace` now takes a plain `workspaceId: string`, not a
  `WorkspaceScope`. A plain string has no cross-module class identity to mismatch. The
  workspace-exists check spec §25 wants is still made, one layer up, in
  `apps/web/server/files/store.ts`'s `createRepositoryObjectStoreProvider`, which resolves and
  discards a real `WorkspaceScope` (via `@agent-workspace/core/db`, consistently through the
  package specifier) before ever calling into this module.
* `object-store-bridge.ts` was pointed at `packages/core/dist/storage/index.js` rather than `src/`,
  which also fixed an unrelated, harder failure: Turbopack could not resolve
  `packages/core`'s own internal NodeNext-style relative imports (`from './object-store.js'`,
  meaningful to `tsc`'s `nodenext` resolution, meaningless to a bundler looking for a literal
  `.js` file next to a `.ts` one) at all, and `next build` failed outright with
  `Module not found: Can't resolve './object-store.js'` before the class-identity issue was even
  reachable.

The consequence, stated plainly because it is a real ordering requirement and not a formality:
**`packages/core` must be built (`pnpm --filter @agent-workspace/core build`) before `apps/web` is
typechecked, linted or built.** `apps/web/package.json`'s own `build`/`dev` scripts already do this;
the wave protocol's "pnpm build BEFORE pnpm test / pnpm lint" already states the same rule at the
repository level. A bare `pnpm --filter @agent-workspace/web typecheck` run before any build, on a
fresh checkout with no `dist/`, will fail to resolve this one import — declared here rather than
discovered by whoever runs that command first.

## Decision 3 — rename and metadata are composed, not new `ObjectStore` methods; empty folders are a declared gap

Spec §16 lists "rename" and "preview metadata" among the Files UI's required operations, and R-15
§1c already establishes that neither is one of the four `ObjectStore` methods: rename is
`CopyObject` + `DeleteObject` on S3, `fs.rename` on a filesystem, and metadata is `HeadObjectCommand`
or a `list` entry's own fields. `handlers.ts`'s `renameFile` composes `get` → `put` → `delete` —
**not atomic**, unlike `fs.rename`, which is a real cost stated here rather than hidden behind a
name that implies otherwise. `listFiles`'s entries already carry every field spec §16 calls
"preview metadata" (`sizeBytes`, `contentType`, `lastModified`), so no separate metadata endpoint
exists.

**Declared gap**: creating an *empty* folder — one with nothing under it yet — is not supported.
`list()` reports a folder once something is `put` under it, matching how S3 itself has no real
directories, only key prefixes. `packages/core/src/db/schema/files.ts`'s `kind: 'folder'` row exists
specifically to represent an empty folder, but that table's repository
(`packages/core/src/db/repositories/**`) is outside this task's `Owns`. Whoever wires the files API
to that table gets empty-folder creation as part of that work; this PR does not invent a
filesystem-only convention (a zero-byte `.keep` object, say) that the metadata table would then have
to either duplicate or contradict.

## Verification round 2: spec §16 asks for eight things, not six

`apps/web/server/files/handlers.ts`'s header quoted §16's bullet list as "upload, download, delete,
rename, folders, preview metadata" and presented that as the whole of what §16 asks for. It is not.
§16's list has eight bullets; the two that were dropped are:

> * assign folders/files to an agent
> * read-only or read-write access

Neither string appears anywhere in this branch's storage or files code, tests or ADRs, and neither
was listed as a gap — so the truncation read as completeness rather than as an omission. ADR-0016's
rule is that an artefact must not assert behaviour that is not so, and the fix is to make the claim
true or delete it, never to soften it: the header now quotes all eight bullets and names the two it
does not implement.

**Declared gap: §16's last two bullets are not implemented.** Both are per-principal authorisation
over a path, and this API has no principal. `http.ts`'s `withWorkspaceObjectStore` resolves a
workspace and nothing finer, so every member of a workspace has identical read-write reach over
every key in it. Implementing either needs a grant table plus the agent and permission repositories
in `packages/core/src/db/repositories/**` (W2-DB-02's) and W2-CP-06's RBAC decision point — none of
them inside this task's `Owns` globs. This is a report, not a repair: it is named here and on the PR
so the wave can route it, and it is not silently absorbed into a claim that §16 is covered.
