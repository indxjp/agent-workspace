# W1-DB-01 — Schema, migration, connection and seed conventions

Status: accepted
Date: 2026-09-03
Scope: task W1-DB-01, and every later schema task that copies it — W2-DB-01 first

**Sources:** spec §25, §27, §28, §29, §37, §39, §40; research note R-15;
[ADR-0004](0004-autonomous-execution.md) (decide, do not ask),
[ADR-0015](0015-gates-decide-on-positive-assertions.md) (a gate decides on a positive assertion),
[ADR-0016](0016-measured-numbers-do-not-live-in-prose.md) (a measured number is emitted, not
written down), and ADR-0017 (a manifest belongs to its package; the lockfile is generated).

> **On the two ADR ids cited here that resolve differently.**
> [ADR-0015](0015-gates-decide-on-positive-assertions.md) and
> [ADR-0016](0016-measured-numbers-do-not-live-in-prose.md) are files on this branch's base and
> the links above resolve. **ADR-0017 is not a file in this tree yet.** It was issued to this
> session as a ruling — a manifest belongs to its package, the lockfile is generated and is
> declared by whoever regenerates it — and `NNNN-` records are the orchestrator's to write
> ([ADR-0003](0003-adr-naming-preserves-file-ownership.md)). It is cited by id below rather than
> as a link that would dangle.

This task is a pattern-setter. The decisions below exist so the Wave 2 schema task copies them
instead of re-deciding them, and so a reviewer can tell a considered choice from an accident.

---

## Context

Wave 1 needs the §27 subset — `workspaces`, `users`, `memberships`, `agents`,
`model_connections`, `sessions`, `runs` — plus a migration, a connection factory and a seed
that creates the built-in **General** agent of §19.5 rule 3. Nothing about the layout of any of
that is fixed by the specification, and R-15 answered the mechanical questions (which Drizzle
commands, which versions, how JSONB is typed) without answering the organisational ones.

---

## Decisions

### 1. One file per table, named after the table, re-exported from `schema/index.ts`

`packages/core/src/db/schema/<table>.ts` defines exactly one table, its closed-set constants,
its Zod schemas and its inferred row types. `schema/index.ts` re-exports all of them and is the
only module `drizzle-kit` and the application read.

*Rejected:* one `schema.ts` (R-15's sketch). It is smaller today and unreadable by Wave 5, when
§27's full table list is present. *Rejected:* grouping by concern (`identity.ts`, `execution.ts`)
— the grouping is a judgement that has to be re-made every time a table is added, and a reader
looking for `runs` should not have to guess which file it is in.

**Adding a table is: add a file, add one line to the barrel.** Never edit another table's file.

### 2. Every column states its own snake_case name; `casing` is not configured

`uuid('workspace_id')`, not `casing: 'snake_case'` inference (which R-15 recommended). With
inference, renaming a TypeScript property silently renames a database column, and the migration
that drops and recreates it looks intentional. With explicit names the two are independent and
a rename is visible in the diff.

**Downside:** the name is written twice, in the property and in the string. Accepted.

### 3. Closed sets are `text` + `enum` for the type **and** a `CHECK` for the database

R-15 §4 verified that Drizzle's `text(name, { enum: [...] })` emits **no constraint at all** —
`'NOT_A_VALID_TYPE'` inserts successfully. Every such column therefore also carries a `CHECK`,
built by `schema/one-of.ts`, whose values come from the same `as const` array the `enum` option
uses, so the two cannot drift.

`CHECK` rather than `pgEnum` because widening a `CHECK` is a one-line `ALTER`, while adding a
value to a PostgreSQL enum type is a migration with lock implications (R-15 §4), and §10's
provider list and §20.6's subject types will both grow.

`oneOf` inlines its values into DDL text, because a bound parameter in a `CHECK` would be
emitted as a literal `$1`. It therefore **rejects** any value that is not a lower-case slug
rather than escaping it — a gate decides on a positive assertion (ADR-0015), and `one-of.test.ts`
exercises nine rejection cases including a quote, a backslash and a `--` comment opener.

### 4. Tenant scoping is a test, not a habit

`schema/tenancy.test.ts` walks every exported table and requires each to be **either** on a
two-entry exemption list carrying a written reason (`workspaces`, because it is the tenant;
`users`, because §21 binds identity to workspace through `memberships` and one identity may sit
in several workspaces) **or** to have `workspace_id NOT NULL` with a foreign key to
`workspaces.id` and an index it leads. There is no third branch: a table that is neither fails
by name.

Carrying the column is necessary and not sufficient, so the same file asks two further
questions of every table (decision 14 is what they enforce):

* **Every reference it makes must be tenant-paired.** Each foreign key is sorted into one of
  four buckets — the reference to the tenant root; a reference to a tenant-*exempt* table, which
  cannot be paired because the target has no `workspace_id`; a paired reference; or an unpaired
  reference whose pairing a sibling constraint carries. A key that fits none of the four is
  collected by name and fails the test. There is no bucket for "everything else".
* **Every `uuid` column named `*_id` must be covered by a foreign key.** Without this the rule
  above could be satisfied by deleting the constraint: a bare `agent_id uuid not null` has no
  reference to pair, so it would pass by having nothing to check.

The exempt tables are additionally required *not* to carry a `workspace_id`. Half a scoping is
worse than none, because a query can then filter on a column nothing maintains.

The test also pins the expected table list, so a Wave 2 table cannot arrive in a Wave 1 branch
unnoticed, and it contains a canary asserting that its own index reader works — an earlier
version used `is(value, Column)` on entries that are `ExtraConfigColumn`s, matched nothing, and
reported every table as unindexed. A reader that silently reads nothing is exactly the
ADR-0015 failure mode, so the reader now throws when it cannot parse an index.

### 5. Foreign-key delete behaviour is decided per edge, and two edges disagree on purpose

| Edge | On delete | Why |
| --- | --- | --- |
| `*.workspace_id → workspaces.id` | `cascade` | Deleting a tenant deletes the tenant's data. |
| `memberships.user_id → users.id` | `cascade` | A membership has no meaning without its user. |
| `sessions.user_id → users.id` | **`restrict`** | §36 wants an audit trail. Deleting a user who has run something must be an explicit decision, not a side effect. |
| `sessions.(agent_id, workspace_id) → agents.(id, workspace_id)` | **`cascade`** | §19.5 rule 3 promises the General agent is "deletable like any other". `restrict` would make every agent undeletable after its first use. |
| `runs.(session_id, workspace_id) → sessions.(id, workspace_id)` | `cascade` | Follows the edge above: a session that goes takes its runs. |
| `agents.model_connection_id → model_connections.id` | `set null` | Deleting a connection must degrade agents to the default model, visibly and recoverably — not delete them. |
| `agents.(model_connection_id, workspace_id) → model_connections.(id, workspace_id)` | `no action` | Pairing only. The edge above carries the delete behaviour; see decision 14 for why it takes two constraints. |
| `sessions.(workspace_id, user_id) → memberships.(workspace_id, user_id)` | `no action` | Refuses to orphan a session. PostgreSQL's default, and measurably indistinguishable from `restrict` on a `NOT DEFERRABLE` constraint — this row is not a behavioural choice; see decision 14. |

**Downside, stated:** deleting an agent destroys its sessions and their runs. The alternative
(nullable `agent_id`) keeps orphaned history at the cost of breaking §19.5's promise or leaving
history that cannot say what produced it. If run history must outlive agent deletion, the fix is
an archival copy, not a nullable foreign key.

### 6. `runs` stores neither `agent_id` nor `duration`, though §35 lists both

§35 lists what a run *records*, which is not the same as what the table *stores*. A run reaches
its agent through `sessions.agent_id`, which §19.5 rule 4 fixes for the life of the session; a
second copy could disagree and nothing in the schema would prevent it. Duration is
`ended_at - started_at`. One join and one subtraction are cheaper than two values that can
contradict each other.

`workspace_id` **is** a second copy, of `sessions.workspace_id`, and it is kept because §25's
tenant filter has to be an index scan on `runs` alone. Keeping it obliges the schema to make the
two copies agree, which is what `runs_session_workspace_fk` does (decision 14). A denormalised
copy is acceptable when a constraint enforces it and not otherwise; that is the line this
paragraph and decision 14 draw together.

`model` and `provider` **are** stored, because they are history: the model connection can be
edited or deleted after the run, and a run record that changes retroactively is not a record.

`runs_ended_at_iff_terminal` makes "finished" and "has an end time" the same fact. Without it a
`completed` run with a NULL `ended_at` renders as `NaN` seconds in the UI — the ADR-0015 shape,
moved one layer earlier so it cannot reach a renderer.

**Not stored in this wave:** cache-read and cache-creation token counts. §35 does not list them
and `cost_usd` is recorded directly. If a later wave needs per-token cost reconstruction it adds
two columns; that is a smaller change than carrying them unused.

### 7. Money is `numeric`, and therefore a string in TypeScript

`cost_usd numeric(14,6)`. R-15 §4 verified that Drizzle maps `numeric` to `string`, not
`number`, and that is the point: §20.6.3 spends this value against a workspace budget, and it
must not pass through a JavaScript float on the way.

### 8. JSONB columns are Zod-first, and every read parses

`agents.permissions` and `model_connections.config` follow R-15 §4 exactly: the Zod schema is
the source of truth, `$type<T>()` is derived from `z.infer`, and the module exports a
`parse…` function that every read boundary must use. R-15 established that `$type` is a
compile-time hint that Drizzle does not enforce — `mapFromDriverValue` hands unparseable input
back as a raw string still typed as `T` — so the inferred type is a convenience, never evidence.

Both Zod objects are `.strict()`. An unknown key is a setting the §5 compile step does not know
how to map onto an SDK option, and dropping it silently is what ADR-0015 forbids.

Neither column has a database default. An agent whose permissions nobody chose is an agent
whose blast radius nobody chose; `{}` is a decision and has to be written as one.

### 9. Migrations: `drizzle-kit generate` at author time, the runtime migrator at deploy time

Per R-15 §3, verified there. `migrations/` sits at the repository root (§29), is committed, and
uses the `index` prefix (`0000_init.sql`) with an explicit `--name`, so a directory listing and
the apply order are the same sort. The deploy-time path is `packages/core/src/db/migrate.ts`,
which uses `migrate()` from `drizzle-orm/node-postgres/migrator` — no `drizzle-kit`, no esbuild,
no TypeScript in the runtime image.

`migrate.ts` carries the two guards R-15 verified are necessary:

* a **PostgreSQL advisory lock on a dedicated `pg.Client`** — never on a connection from the
  pool `migrate()` uses, which R-15 observed deadlocking past 300 s;
* a **drift assertion**: the journal's entry count must equal the ledger's row count. R-15
  verified that an out-of-order migration is skipped **silently with exit code 0** and that
  `drizzle-kit check` reports "Everything's fine". The journal is read and validated *before*
  the lock is taken, so a missing or malformed journal fails the migration rather than skipping
  the check.

**Contributor rule, inherited from R-15 and repeated because this repository stacks branches:**
if `migrations/meta/_journal.json` changed on your base branch, delete your generated migration
and re-run `pnpm db:generate` so it gets a fresh `when`.

**Not implemented here:** R-15's proposed CI rule that asserts new journal entries post-date
every entry on the base branch. `.github/**` is not this task's to write. Declared as a gap.

### 10. `drizzle.config.ts` lives beside the schema, not at the repository root

R-15 sketched it at the root. The root is not this task's to write, and the arrangement is
better anyway: schema, config, migrator and seed are one directory. Paths in it are relative to
`packages/core`, which is where the script runs.

**Downside, stated:** the file is inside `src`, so `tsc -p tsconfig.build.json` compiles it to
`dist/db/drizzle.config.js`, where it imports `drizzle-kit` — a devDependency — at a path
nothing ever loads. It is inert, and excluding it would mean editing `tsconfig.build.json`,
which this task does not own.

### 11. Scripts: three at the root, all thin delegations

Root `package.json` gains only `db:generate`, `db:migrate`, `db:seed`, each of which is
`pnpm --filter @agent-workspace/core run <same name>`. Every dependency and every real command
lives in `packages/core`, so the root manifest carries no database knowledge.

`db:migrate` and `db:seed` build first (`pnpm run build && node dist/db/<entry>.js`) so a
developer can run them from a checkout. **In a container, run `node dist/db/migrate.js`
directly** — the image is built already, and R-15 §3 is explicit that migration is a one-shot
job or init container, never something a serving process does.

### 12. The seed is idempotent by natural key, and refuses to invent an administrator

Every insert is `ON CONFLICT DO NOTHING` against a real unique constraint (`workspaces.slug`,
`users.email`, `memberships (workspace_id, user_id)`, `agents (workspace_id, name)`), all inside
one transaction. Nothing counts rows and infers a state from the count. `workspaces.slug` exists
principally to give the seed something to key on.

`agents (workspace_id, name)` is unique because §19.5's picker labels agents by name, and
because it is what makes "exactly one General agent" a database property rather than a hope.
It applies to every agent equally, so it is not a special case for the built-in one.
**Downside:** two agents in one workspace cannot share a name; a rename collision surfaces as a
constraint error the UI must handle.

`BOOTSTRAP_ADMIN` is **required**. There is no default administrator identity: §21's whole
authorization model hangs off this row, and a seed that invents one creates an account nobody
chose. §37 already lists `BOOTSTRAP_ADMIN` as a deployment-level value.

### 13. The General agent has no marker of any kind

§19.5 rule 3 says it is "an ordinary row in `agents`, editable and deletable like any other".
So: no `is_builtin` column, no reserved UUID, no branch anywhere on the name. `seed.test.ts`
proves it two ways — it pins the exact column list of `agents` (a marker column would fail it)
and it inserts a user-created agent with the same settings and asserts every non-identity
column is equal.

### 14. A reference between two tenant-scoped tables is a **composite** foreign key

`workspace_id` is on `sessions` and on `runs` as well as on the rows they point at, so the
copies can disagree. A single-column `sessions.agent_id -> agents(id)` says only that the agent
exists *somewhere*: nothing then stops a session in workspace B naming an agent in workspace A,
or a run carrying a `workspace_id` different from its session's. Both were demonstrated against
a migrated PostgreSQL 17 during review; both were accepted by the schema as it first stood.

The rule, applied to every reference from one tenant-scoped table to another:

    UNIQUE (id, workspace_id) on the target, and
    FOREIGN KEY (target_id, workspace_id) REFERENCES target (id, workspace_id)

`sessions_agent_workspace_fk`, `runs_session_workspace_fk` and
`agents_model_connection_workspace_fk` are that shape. `sessions_member_workspace_fk` is the
same idea applied to authorization rather than to a denormalised copy: the person a session
belongs to must hold a `memberships` row in that workspace, so `user_id` alone can no longer
attach a session to somebody who was never a member.

Three consequences worth stating, because each is a place this could have gone wrong:

* **The `(id, workspace_id)` targets are table CONSTRAINTS, not unique indexes.** `drizzle-kit`
  emits every `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` *before* any `CREATE UNIQUE INDEX`,
  so a composite key pointing at a unique index fails the migration with "there is no unique
  constraint matching the given keys". A constraint is emitted inside `CREATE TABLE`.
* **`agents.model_connection_id` needs two constraints, not one.** It is `ON DELETE SET NULL`,
  and a composite `SET NULL` nulls every column of the key — including `workspace_id`, which is
  `NOT NULL`. PostgreSQL 15+ can restrict the action to named columns, but `drizzle-orm@0.45.2`
  cannot express it: `UpdateDeleteAction` in `pg-core/foreign-keys.d.ts` is a bare string union
  with no column list. So the single-column constraint carries the delete action and a second,
  tenant-paired constraint carries the isolation. `MATCH SIMPLE` — PostgreSQL's default — does
  not enforce a composite key when any of its columns is NULL, which is exactly the state
  `SET NULL` leaves behind.
* **`sessions_member_workspace_fk` is `NO ACTION` because that is the default, and for this
  constraint nothing can tell it from `RESTRICT`.** An earlier revision of this record claimed
  `RESTRICT` "is checked the instant the `memberships` row goes" and that a named test held the
  choice. Both statements were wrong, and the correction is recorded here rather than quietly
  edited, because W2-DB-01 is told to copy this record.

  In PostgreSQL, `RESTRICT` and `NO ACTION` are **both** `AFTER ROW` triggers — `pg_trigger`
  gives `RI_FKey_restrict_del` and `RI_FKey_noaction_del` the identical `tgtype = 9`
  (ROW | DELETE, not BEFORE) — so both are checked at end of statement, not when the row goes.
  The only difference this probe found is deferrability, and it is invisible unless the
  constraint is declared `DEFERRABLE`. Probed on PostgreSQL 17.11 against the real shape
  (`workspaces` cascading into both `memberships` and `sessions`), all four combinations:

  | declared | `ON DELETE` | delete the workspace, one statement | delete the membership under a live session | txn: membership, then session, then `COMMIT` |
  | --- | --- | --- | --- | --- |
  | `NOT DEFERRABLE` | `no action` | accepted, `w=0 s=0 m=0` | rejected by name | rejected by name |
  | `NOT DEFERRABLE` | `restrict` | accepted, `w=0 s=0 m=0` | rejected by name | rejected by name |
  | `DEFERRABLE INITIALLY DEFERRED` | `no action` | accepted, `w=0 s=0 m=0` | rejected by name | **accepted**, `s=0 m=0` |
  | `DEFERRABLE INITIALLY DEFERRED` | `restrict` | accepted, `w=0 s=0 m=0` | rejected by name | rejected by name |

  The mechanism, read out of `pg_trigger` rather than asserted — `RESTRICT`'s delete trigger is
  a *different function*, and it stays non-deferrable even when the constraint itself says
  `DEFERRABLE` (`condeferrable = t`). The delete rows of the probe's trigger listing, which
  prints four rows per constraint:

  ```
  ACTION: no action | DECLARED: deferrable initially deferred
         proname        | tgdeferrable | tginitdeferred
  ----------------------+--------------+----------------
   RI_FKey_noaction_del | t            | t

  ACTION: restrict | DECLARED: deferrable initially deferred
         proname        | tgdeferrable | tginitdeferred
  ----------------------+--------------+----------------
   RI_FKey_restrict_del | f            | f
  ```

  That is why the fourth row of the table above still rejects: the `DEFERRABLE` keyword is
  accepted on a `RESTRICT` constraint and changes nothing.

  This constraint is `NOT DEFERRABLE`, so it sits in the top two rows, where the two actions
  are identical. `no action` is therefore not a behavioural decision: it is the default, and it
  is the one that keeps the deferrable option open if a future wave ever needs to write a
  membership hand-off in one transaction. **No test discriminates the two, and none can while
  the constraint is not deferrable** — so this record names none.

**Downside:** removing a member from a workspace now fails while they own sessions there. That
is deliberate — it is the same trade `sessions.user_id -> users(id) ON DELETE RESTRICT` already
made for §36's audit trail — but it is a new error the membership UI has to handle, and it is
listed under Honest downsides below.

`tenancy.test.ts` enforces the rule for every future table without anybody remembering to: it
walks each foreign key the schema declares, sorts it into one of four accepted buckets, and
fails on anything left over. `seed.test.ts` proves the same rule against a real PostgreSQL, one
rejected statement and one accepted statement per constraint.

**The structural half has one blind spot, and it is closed by naming, not by a rule.** The
bucket rules classify a constraint from its own columns, so they notice a missing constraint
only when its absence leaves a hole: a `*_id uuid` column no foreign key covers, or a reference
to a tenant-scoped table nothing pairs. Deleting each constraint from the schema and running
`tenancy.test.ts` alone measures exactly how much that catches:

```
--- structural rules only, before the registry was added (25 tests) ---
dropped sessions_agent_workspace_fk              2 failed | 23 passed (25)
dropped runs_session_workspace_fk                1 failed | 24 passed (25)
dropped agents_model_connection_workspace_fk     1 failed | 24 passed (25)
dropped sessions_member_workspace_fk                        25 passed (25)   <-- the hole
```

`sessions_member_workspace_fk` leaves no hole: `workspace_id` is already covered by the
reference to `workspaces`, `user_id` by the reference to `users`, and because `users` is
tenant-exempt, `sessions.user_id -> users.id` is a legitimate bucket-2 reference standing on
its own. The constraint expresses an **authorization** rule, not a denormalisation, and no rule
over column shapes implies it. So `tenancy.test.ts` carries a small `REQUIRED_REFERENCES`
registry that names it and asserts its exact reference — a positive assertion under ADR-0015,
which fails if the constraint is deleted, renamed or repointed, and which needs no database, so
it runs on `pnpm test` in CI today (`.github/workflows/ci.yml:139`) rather than waiting for the
PostgreSQL service that gap 3 is about. Repeating the same four deletions with the registry in
place:

```
--- with the registry (27 tests) ---
dropped sessions_agent_workspace_fk              2 failed | 25 passed (27)
dropped runs_session_workspace_fk                1 failed | 26 passed (27)
dropped agents_model_connection_workspace_fk     1 failed | 26 passed (27)
dropped sessions_member_workspace_fk             1 failed | 26 passed (27)   <-- now caught
```

A schema task that adds a constraint of this kind — one whose columns are individually already
covered by other references — must add it to that registry, because nothing else will.

### 15. `allowBuilds: { esbuild: false }` in `pnpm-workspace.yaml`

`drizzle-kit` pulls esbuild, which ships an install script. pnpm 11 treats an unanswered install
script as an **error** (`ERR_PNPM_IGNORED_BUILDS`, exit 1), so `pnpm install --frozen-lockfile`
— CI's first step — fails until the question is answered, and pnpm 11 no longer reads the `pnpm`
field in `package.json`, so `pnpm-workspace.yaml` is the only place an answer can live.

The answer is **deny**, and the deny is tested rather than assumed: `pnpm db:generate` produces
the migration correctly with the script denied. A build-time-only package does not get to
execute code at install.

**This file is outside the task's declared `Owns` globs.** It is declared on the pull request
and called out as a deviation. There was no alternative inside the globs: the setting has no
other home, and without it the branch cannot install.

### 16. The Agent SDK dependency is not added here

`packages/core` does not import `@anthropic-ai/claude-agent-sdk` and does not declare it. Its
home is `apps/runner/package.json` (§42), which is not in this task's `Owns` globs, and under
pnpm's isolated `node_modules` a declaration in `packages/core` would not resolve from
`apps/runner` in any case.

This was escalated during the task, because the dependency-batching rule as it then stood asked
this task to add every dependency Wave 1 needs. **ADR-0017 resolved it the other way: a manifest
belongs to its package, and the lockfile is generated by whoever changes a manifest and declared
by them.** The wiring is task W1-DEP-01's. Nothing about the SDK is this task's to do, and no
part of this branch pretends otherwise.

### 17. No `relations()` declarations

Drizzle's relational query builder needs `relations()` metadata for `with:`. Nothing in this
wave uses it, and §39 prefers low code volume. Joins are explicit. A later wave that wants
`with:` adds the relations for the tables it needs.

---

## Consequences

* Wave 2's schema task adds files to `schema/`, adds lines to the barrel, and inherits the
  tenancy test for free — including the requirement to justify any new exemption in writing.
* The acceptance evidence for this task was produced against `postgres:17-alpine` (17.11) in
  Docker, not against a mock.
* Two files outside the declared `Owns` globs were touched: `pnpm-workspace.yaml`
  (decision 15) and `docs/adr/README.md`, which is generated — adding this record makes the
  committed index stale and `sh docs/adr/regenerate-index.sh --check` is a blocking CI step, so
  the script was re-run rather than the table edited. The root `package.json` change is confined
  to its `scripts` block, as the task card requires. All are declared on the pull request.

## Honest downsides, collected

1. A unique agent name per workspace is a constraint the specification never asked for.
2. Deleting an agent deletes its run history.
3. `drizzle.config.ts` is compiled into `dist` where it is dead weight.
4. `updated_at` is maintained by Drizzle, not by a trigger, so a hand-written `UPDATE` leaves
   it stale.
5. The database-backed acceptance suite is skipped when `TEST_DATABASE_URL` is unset, which is
   the case in CI today, because `.github/**` is not this task's to change.
6. Removing a member from a workspace fails while that member still owns sessions in it
   (decision 14). The membership UI has to offer reassign-or-delete rather than a bare remove.
7. The tenant pairing is more schema than the specification asks for in words: extra foreign
   keys, and a unique constraint on each table they point at. Every one of them is a check the
   database performs on write. `migrations/0000_init.sql` is the list; it is not repeated here,
   because a count written in prose goes stale the moment a table is added.
