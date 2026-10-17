# W2-CP-04 — The exact call that installs the skills runtime, for whoever owns `apps/web/instrumentation.ts`

Status: accepted, corrected round 2 (B3) — see "Round 2 correction" below before "The call"
Date: 2026-09-06
Decided by: W2-CP-04 (skills)
Scope: informative only — `apps/web/instrumentation.ts` is not in this task's `Owns` globs (ADR-0038)

## Round 2 correction (B3) — read this before "The call"

Round 1's version of this ADR claimed *"`keys.ts`'s `skills/` and `skill-meta/` prefixes are chosen
precisely so they cannot collide with anything `apps/web/server/files/**` addresses"* and, on that
claim, recommended **one** `createLocalFilesystemObjectStoreProvider(rootDir)` reused for both the
files and skills runtimes. **That claim is false, and the wiring it recommended is unsafe.** The
verifier wired exactly the recommended shape and drove it through the real routes:

    POST /api/skills {name:"invoice-review", SKILL.md with description: real}   -> 201
    GET  /api/files?path=  -> 200 {"files":[{"path":"skill-meta",...},{"path":"skills",...}]}
    POST /api/files  x-file-path: skills/invoice-review/SKILL.md  (description: TAMPERED) -> 201
    POST /api/files  x-file-path: skill-meta/ghost.json  (a hand-written meta record)     -> 201
    GET  /api/skills/invoice-review -> 200 ..."description":"TAMPERED"...
    GET  /api/skills -> 200 {"skills":[{"name":"ghost","enabled":true,"fileCount":0,...},
                                        {"name":"invoice-review","description":"TAMPERED",...}]}

`keys.ts`'s structural argument holds for what it actually claims: **`skills/` and `skill-meta/`
cannot collide with each other**, for any `<name>` or `<relativePath>` — that part is real and
untouched by this correction. What round 1 got wrong is generalising it into a claim about a
*different* API's key space. The files API's key is `toObjectKey(input.path)` — the caller's own
path string, rooted at whatever directory the files runtime's provider was given. If that directory
is the **same** directory the skills runtime's provider was given, `skills/` and `skill-meta/` are
just two more caller-addressable folders sitting in it, because nothing about `toObjectKey` knows
those two segments mean anything special. One shared root does not keep the two APIs' namespaces
apart; it merges them, and `apps/web/server/files/**` is not this task's to change to fix that (and
must not be — see "What this task does NOT ask the integrator to add").

**The safe wiring is two separate root directories, not two providers over one root.** Concretely,
in place of the single call round 1 showed, the integrator should make two:

```ts
import path from 'node:path';
import { configureFilesRuntime } from './server/files/runtime';           // W2-CP-03, unchanged
import { createRepositoryObjectStoreProvider } from './server/files/store';
import { createLocalFilesystemObjectStoreProvider as createFilesStore } from './server/files/object-store-bridge';
import { configureSkillsRuntime } from './server/skills/runtime';
import { createRepositorySkillsStoreProvider } from './server/skills/store';
import { createLocalFilesystemObjectStoreProvider as createSkillsStore } from './server/skills/object-store-bridge';

const scopes = /* the one WorkspaceScopeResolver both runtimes already share */;
const resolveWorkspace = /* the one session→workspace resolution both runtimes already share */;

configureFilesRuntime({
  store: createRepositoryObjectStoreProvider({
    store: createFilesStore(path.join(OBJECT_STORE_ROOT_DIR, 'files')),
    scopes,
  }),
  resolveWorkspace,
});

configureSkillsRuntime({
  store: createRepositorySkillsStoreProvider({
    store: createSkillsStore(path.join(OBJECT_STORE_ROOT_DIR, 'skills-platform')),
    scopes,
  }),
  resolveWorkspace,
});
```

Two provider instances, each rooted at its own subdirectory of `OBJECT_STORE_ROOT_DIR`. A files-API
caller's `toObjectKey(input.path)` is resolved against the `files/` subdirectory only — the
`skills-platform/` subdirectory (which is where this task's `skills/` and `skill-meta/` prefixes
actually land once this correction is wired) is a sibling directory no files-API key can ever be
rooted at, structurally, not by a spelling rule either provider re-checks per request. This is the
smaller change from round 1's text (two directory arguments, not a new abstraction), and it is what
this ADR now recommends. `docs/adr/W2-CP-03-object-key-safety.md`'s own rule applies one level up
here too: **put the thing a caller must not reach in a tree no caller key addresses** — a directory
the files runtime's provider was never given *is* such a tree.

Everything below this section is round 1's original text, describing the **unsafe** single-root
wiring. It is left in place, struck through in spirit if not in markdown, so the record shows what
was recommended and corrected rather than silently rewriting history — but **the integrator must
follow the two-root wiring above, not the single call below.**

## Context

ADR-0038 holds `apps/web/instrumentation.ts` at the integration level for the whole of Wave 2:
every feature track ships a `configure<X>Runtime` function and names, in an ADR, the exact call
that installs it, rather than editing the composition root itself. Sub-wave 2b-1 lost a full round
to this rule being unstated; sub-wave 2b-2 (this task and W2-CP-05) has a named integration task
(`W2-INT-02`) dispatched ahead of it for exactly that reason.

Until that call is made, every skills route answers `503 skills_runtime_not_configured` — on
purpose, not as a bug — because `apps/web/server/skills/runtime.ts`'s `currentSkillsRuntime()`
returns `null` and `withWorkspaceSkillsStore` (`http.ts`) refuses to guess a store or a workspace.

## The call — SUPERSEDED, round 2 (B3). Do not follow this section; follow "Round 2 correction" above.

**Everything from here to "What this task does NOT ask the integrator to add" is round 1's
original recommendation, kept verbatim for the record. It recommends the single-root wiring the
round 2 correction above proves unsafe. Follow the two-root code block above instead — the sample
below is history, not an instruction.**

```ts
// SUPERSEDED — do not wire this. See "Round 2 correction" above for the safe two-root version.
import { configureSkillsRuntime } from './server/skills/runtime';
import { createRepositorySkillsStoreProvider } from './server/skills/store';
import { createLocalFilesystemObjectStoreProvider } from './server/skills/object-store-bridge';
// or, once it exists: an S3/MinIO provider from the same bridge — see
// docs/adr/W2-CP-03-s3-minio-backend-blocked.md.

configureSkillsRuntime({
  store: createRepositorySkillsStoreProvider({
    store: createLocalFilesystemObjectStoreProvider(OBJECT_STORE_ROOT_DIR),
    scopes: /* the same WorkspaceScopeResolver apps/web/server/files/runtime.ts's install
               already resolves from @agent-workspace/core/db's openDatabaseRoot() */,
  }),
  resolveWorkspace: /* the same session→workspace resolution
                        apps/web/server/files/runtime.ts's install already uses */,
});
```

~~`OBJECT_STORE_ROOT_DIR` should be the **same** root directory the files runtime's own
`createLocalFilesystemObjectStoreProvider` call is given: both this task and W2-CP-03 write into
one `ObjectStore` per workspace, and `keys.ts`'s `skills/` and `skill-meta/` prefixes are chosen
precisely so they cannot collide with anything `apps/web/server/files/**` addresses (files never
issue a key with either literal prefix as its own top-level segment — a files-side key is always
one the caller spelled directly, at the workspace root, with no platform-invented prefix in front
of it). Concretely: one call to `createLocalFilesystemObjectStoreProvider(rootDir)`, reused for
both `createRepositoryObjectStoreProvider` (files) and `createRepositorySkillsStoreProvider`
(skills), is correct and is what this ADR recommends — not two providers over two root
directories, which would need its own reasoning about whether the two trees may ever need to
merge.~~ **False — see "Round 2 correction" above. The files API's key is `toObjectKey(input.path)`
at the shared root, so a shared root makes `skills/` and `skill-meta/` ordinary caller-addressable
folders through `GET`/`POST /api/files`. Use two roots.**

`resolveWorkspace` and the `WorkspaceScopeResolver` are exactly the same shape
`apps/web/server/files/runtime.ts` needs (`W2-CP-03`'s own composition-root note, folded into that
task's `object-store-bridge.ts` and `store.ts` headers) — this task adds no new authentication or
authorization concept, and the integrator should wire both runtimes from the same session lookup.

## What this task does NOT ask the integrator to add

No dependency, no `packages/core/package.json` change, no `exports` subpath.
`@agent-workspace/core/storage` already carries the subpath this task needs (landed by W2-INT-01
for W2-CP-03); this task's `object-store-bridge.ts` imports it exactly as
`apps/web/server/files/object-store-bridge.ts` does.

## Verification this task performed without the call existing

`apps/web/server/skills/routes.test.ts` calls `configureSkillsRuntime`/`clearSkillsRuntime`
directly, the same way `apps/web/server/files/routes.test.ts` does, and separately asserts the
unconfigured path answers `503` (never `401`, never an empty `200`) with nothing wired — proving
the fail-loud contract without needing the integration branch to exist yet.
