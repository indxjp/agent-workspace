# W2-CP-04 — A skill's files and this platform's record about it share one `ObjectStore`, in two prefixes that no caller's key can make collide

Status: accepted
Date: 2026-09-06
Decided by: W2-CP-04 (skills)
Scope: `apps/web/server/skills/**`, `apps/web/app/api/skills/**`

## Context

This task's brief is explicit: store a skill's files "through the ObjectStore that W2-CP-03
landed... Do not write a second storage layer," and read
`docs/adr/W2-CP-03-object-key-safety.md`'s key-safety ADR before designing a key scheme, because
"a skill name comes from a caller" and that ADR's rule is "a backend must not place anything a
caller must not reach at a name derived from a caller's key."

That rule was earned the hard way, three times, on a sibling problem: `local-fs-store.ts`'s
content-type sidecar was named by appending a suffix to the object's own key, and every attempt to
protect that derived name by *spelling* — an exact suffix, a case-blind marker, a `%`-escaped
marker — fell to a different alias the filesystem minted for the derived name (case folding, then
an NTFS 8.3 short name). The fix that held moved the sidecar to a sibling tree (`metadata/`) that
no object key resolves into at all, so no spelling of any key can ever address it.

This task has the same shape of problem, one level up. A skill has:

1. **Its own files** — `SKILL.md` and whatever supporting files a caller uploads, addressed by a
   caller-controlled name and caller-controlled relative paths.
2. **This platform's own record about it** — today, just `enabled` and two timestamps — which a
   caller does not supply and must not be able to overwrite by naming one of their own files
   cleverly.

## Decision 1 — two top-level prefixes, never one derived from the other

```
skills/<name>/<relativePath>     the skill's own files
skill-meta/<name>.json           the platform's own record
```

`<name>` is caller-controlled (see Decision 3 for its grammar); the two literal prefixes —
`"skills/"` and `"skill-meta/"` — are not, and are written in exactly one place,
`apps/web/server/skills/keys.ts`. `ObjectStore` compares keys as exact strings with no
normalisation between them (`key-safety.ts`'s "filter, never a rewriter" contract), so a string
built by joining a caller's relative path onto `skills/<name>/` can never equal one that starts
with the literal `skill-meta/` — not for any value of `<name>` or the relative path, because the
caller's own path is only ever joined at one position, after `skills/<name>/`, and never anywhere
that could produce a leading `skill-meta/`.

This is deliberately **not** a metadata *file* placed inside `skills/<name>/` under a reserved
name (e.g. `skills/<name>/.skill-meta.json`) — that would be exactly the pattern that failed three
times for the object-store's own sidecar: a caller who names a supporting file `.skill-meta.json`
would be naming the platform's own record, and `key-safety.ts`'s `reserved-name` rule (built for
the literal word `__objectstore_meta__`, not for any word this task invents) would not refuse it.
Two disjoint top-level prefixes make the question moot rather than defended.

## Decision 2 — the platform's own record never touches Postgres

`packages/core/src/db/schema/skills.ts` already models a `skills` table with `name`, `skill_md`
and `enabled` columns (landed on `main` by W2-DB-01), and its own header anticipates a repository
over it. **No such repository is reachable from `apps/web`**: `packages/core/src/db/repositories/**`
is outside this task's `Owns` globs, `@agent-workspace/core/db`'s barrel re-exports only what
`repositories/index.ts` exports (enforced by `database-reachability.test.ts`), and no
`SkillRepository` is exported there today. Reaching the table any other way — a relative import of
`packages/core/src/db/schema/skills.ts`, or `@agent-workspace/core/db/unscoped` — is either outside
this task's `Owns` globs to add, or a test-only escape that throws outside a test process by
design.

So this task keeps `SKILL.md`'s bytes, every supporting file, and the platform's own
`enabled`/timestamp record all inside the workspace's `ObjectStore`, and touches no Postgres table
at all. That is a deliberate reading of "do not write a second storage layer" — the alternative,
splitting a skill's identity across Postgres (metadata) and the `ObjectStore` (files), *would* be a
second storage layer for exactly the same resource, with the two able to disagree about which
skills exist.

**Declared gap.** `skills.skill_md`, `skills.enabled` and `agent_skills` all exist on `main` and go
unused by this task. Whoever next owns `packages/core/src/db/repositories/**` and needs the
`skills` table can build a `SkillRepository` and a migration path that reads this task's ObjectStore
layout; this task states the dependency rather than reaching across its `Owns` globs to add it
(ADR-0038's shape, applied to a resource-owning task rather than to the composition root).

## Decision 3 — the skill name grammar is copied from the Postgres CHECK constraint, not invented

`isValidSkillName` in `keys.ts` is exactly `skills_name_shape`'s regex —
`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$` — copied as a literal rather than imported (there is
nothing to import; see Decision 2). Copying the same grammar rather than a looser one means a name
this API accepts today is a name Postgres would also accept once a repository exists, so no future
migration into that table has to reject data this API already let in. It is also strictly narrower
than the Agent SDK's own skill-name validator (R-01 §8: no parentheses, no wildcard suffix, etc.) —
a lower-case-digit-hyphen slug can never spell any of R-01's forbidden shapes — which is what R-01
§8 asks for directly: *"The platform must validate skill names on save (spec §7), not at run
time."*

A name that is exactly one grammar-checked slug also can never contain a `/`, a `..` segment, or
the object-store's own reserved marker (which has underscores, excluded by this grammar), so
`skills/<name>` and `skill-meta/<name>.json` always name exactly what they appear to, for every
name this API accepts.

## Decision 4 — a JSON manifest of base64 files, not a multipart or archive upload

`POST /api/skills`, `PATCH /api/skills/:name` and `GET /api/skills/:name?export=true` all carry a skill's
files as `{"path": "...", "contentBase64": "..."}` entries in a JSON body, not as raw multipart
parts (`files/route.ts`'s approach) and not as a zip or tar archive.

Two reasons, in order of weight:

1. **No archive library is available to add.** `packages/core/package.json` and
   `apps/web/package.json` belong to the integration level (ADR-0038); this task cannot add a zip
   or tar dependency, and none is already a transitive dependency of anything this task can import.
   A hand-rolled archive format would be a second, bespoke wire format nobody asked for.
2. **Byte-identity is a property of never treating a file's content as text.** Every file's bytes
   travel as a base64 string — a caller-opaque ASCII payload — from `Buffer.from(x, 'base64')` on
   import straight into `ObjectStore.put`'s `Uint8Array`, and back out through
   `Buffer.from(bytes).toString('base64')` on export. Nothing in that path ever calls a text
   encoding on the file's own bytes, so the classic Windows trap this task's acceptance criterion
   is aimed at — CRLF normalisation, an implicit text mode, a trailing newline added or removed —
   has no code path through which to happen. `local-fs-store.ts`'s own header, independently, names
   this exact task and this exact requirement as the reason it never opens a file in text mode.

A **declared gap** follows from base64 being ASCII: `Buffer.from(x, 'base64')` silently drops
characters it does not recognise rather than throwing on a malformed string, so `handlers.ts`
validates every `contentBase64` value against a positive base64 grammar (`BASE64` in
`handlers.ts`) before decoding it, refusing anything else with `400 malformed_content` — ADR-0015's
"a check that cannot run must fail," applied to a decoder that would otherwise fail open.

## Decision 5 — import and edit are not atomic, and a rejected request can leave orphaned bytes behind

`importSkill` writes each file's bytes in the order the request listed them, and only writes the
`skill-meta/<name>.json` record — the thing that makes a skill visible to `listSkills`/`getSkill`/
`exportSkill` — after every file write has succeeded. So a request whose *n*-th file fails
`key-safety.ts`'s guard (a `..` segment, most likely) has already written files `1..n-1` to
`skills/<name>/` before the `400` is returned, and never writes the metadata record. The failed
skill is therefore invisible through this API — nothing lists it, `GET` 404s it, a retried
`POST` under the same name is accepted rather than conflicting — but the orphaned bytes remain on
the backing store until a later successful import of the same name overwrites them, or forever if
one never comes. The same shape applies to `patchSkill`'s `files`/`removeFiles` arrays.

This is the same trade-off `local-fs-store.ts` already makes and declares for its own `put`/
`delete` (two writes, not wrapped together), extended one level up: a `Promise.all` or a
compensating rollback was rejected because a partial failure would then have to *undo* already-
persisted bytes through the same non-transactional `ObjectStore`, which cannot do more to make that
safe than the sequential version already does. Declared here rather than repaired, because
repairing it needs a transactional primitive this store does not have.

## Decision 6 — "export it" is a query flag on `GET /api/skills/:name`, not a `/:name/export` route

The first revision of this task shipped `GET /api/skills/:name/export` as its own route file. It
was reverted after `apps/web/server/rbac/authorisation-matrix.test.ts` — repo-wide, owned by
W2-CP-06 under ADR-0019 — refused every role on it:

```text
"export" is not a sub-resource spec §21's permission split classifies under "skills" (no
sub-resource of it is classified). Add it to SUB_RESOURCES in apps/web/server/rbac/permissions.ts
with the reading of §21 that decides its grants, or classify it as a resource of its own. An
unclassified sub-resource is refused, never given its parent's grant (ADR-0015).
```

ADR-0040 gives a task shipping a `/:id/<sub>` route its own
`apps/web/server/rbac/declarations/<TASK-ID>.ts` for exactly this, so this task is not blocked on
editing `permissions.ts` itself — but ADR-0040 §"Why the index is here" is explicit that the
declaration union (`apps/web/server/rbac/declared-sub-resources.ts`) is composed through
**written-out static imports**, one line per task, because `decide()` runs inside a bundled
Next.js server and cannot read a directory at request time. Landing a declaration file with no
import line for it is the identical shape ADR-0038 describes for `apps/web/instrumentation.ts`: a
seam only the integration level closes.

Two paths were open: ship the declaration file and state the one import line
`apps/web/server/rbac/declared-sub-resources.ts` needs (the ADR-0038 shape, one layer up), or
remove the need for a classification at all. This task takes the second, because it costs nothing
real: `export` becomes `?export=true` on the identical `GET /api/skills/:name` path §21 already
classifies as `skills` — the same choice `W2-CP-03` already made for its own read-a-location verb
(`GET /api/files?path=…`, never a path segment). No sub-resource, no declaration file, no import
this task cannot add, and one fewer route for `tests/route-inventory.test.ts`'s declared-surface
count to carry (see the Consequences note on that gate, below).

The response shape is unchanged — `{"skill": {"name", "files": [{"path", "contentBase64"}]}}` —
and `apps/web/app/api/skills/[name]/route.ts`'s own header carries this reasoning next to the code
it explains, per this repository's convention of stating a non-obvious route shape where the route
is, not only here.

## Consequences

* `tests/route-inventory.test.ts`'s "reads spec §34 and finds the routes it prints" assertion
  checks `specRoutes().size >= EXPECTED_ROUTES.length` as a sanity bound on its own parser. §34's
  own printed block is fixed at 31 routes (it is specification text, not derived), while
  `EXPECTED_ROUTES` is the union of every task's declared surface and grows as ADR-0026-mandated
  routes accumulate across waves — 30 before this task, 34 with this task's four. **This assertion
  fails once total declared routes exceed 31, regardless of which task's addition is the one that
  crosses the line**, and this task's four are legitimate, §7-mandated, individually justified
  routes rather than a padding count. `tests/route-inventory.test.ts` is a repo-wide gate outside
  this task's `Owns` globs (ADR-0019); the fix is a change to that assertion's own bound, which
  belongs to whoever owns it next, not to a resource track. Declared here rather than worked
  around: this task did not reduce its route count to duck under a threshold, because the
  threshold's assumption — that §34's static text stays ahead of the sum of every future track's
  mandated additions — was never going to hold past some task's honest four or five routes, and
  finding that out on this task's four is not a reason to make this task's API worse.
* A skill's export payload (`{"skill": {"name", "files"}}`) is, byte for byte, a valid import body
  for `POST /api/skills` under a different name — the round trip the acceptance criterion asks for
  is literally `export` piped into `import`, and `routes.test.ts` proves it that way.
* `GET /api/skills` and `GET /api/skills/:name` read a skill's `description` by fetching its
  `SKILL.md` and running it through `frontmatter.ts`'s minimal reader, per-request, rather than
  from a column — the same trade-off `docs/adr/W2-DB-01-remaining-section-27-tables.md` names for
  the table this task cannot reach ("the skill list parses front matter per row... SKILL.md is
  small").
* "Assign it to agents" (spec §7) has no route in this task, for the same reason as Decision 2:
  `agent_skills` needs a repository this task cannot add. `apps/web/server/skills/handlers.ts`'s
  header states this as a gap rather than an omission.
