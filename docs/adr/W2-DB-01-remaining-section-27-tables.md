# W2-DB-01 — The remaining §27 tables: what the specification did not name

Status: accepted
Date: 2026-09-04 (decisions 1–10); amended 2026-09-04 in verification round 1 (decision 11, and
the corrections to decisions 7 and 8 that round found to be false); amended again 2026-09-04 in
verification round 2 (decision 12, and the withdrawal of the `parseMcpArgs` claim); amended again
2026-09-04 in verification round 3 (decision 13, and two corrections to `tenancy.test.ts`'s header);
amended again 2026-09-04 in verification round 4 (decision 13's treatment of `CREATE SCHEMA` and
`CREATE EXTENSION`, and further corrections to that header)
Decided by: task W2-DB-01, implementer
Scope: `packages/core/src/db/schema/**`, `migrations/**`, `packages/core/src/db/seed.ts`,
`packages/core/src/db/seed.test.ts`; binding on W2-CP-02 (secrets), W2-CP-03 (files),
W2-CP-04 (skills), W2-CP-05 (connectors), W2-CP-06 (RBAC and API keys) and on W5-DB-01

**Sources:** spec §7, §8, §16, §21, §22, §23, §25, §26, §27, §36; the Wave 2 plan;
[ADR-0015](0015-gates-decide-on-positive-assertions.md),
[ADR-0016](0016-measured-numbers-do-not-live-in-prose.md),
[ADR-0023](0023-wave-2-owns-globs-are-derived-and-the-wave-is-split.md),
[ADR-0027](0027-a-partition-that-lists-its-members-has-not-been-partitioned.md),
[ADR-0028](0028-the-classifier-rule-is-applied-by-enumeration-not-at-the-site-named.md),
[ADR-0029](0029-a-narrowing-is-a-defect-only-when-a-counter-example-exists.md),
[W1-DB-01](W1-DB-01-schema-conventions.md) — which this record extends rather than replaces.

---

## Context

Spec §27 prints a list of table **names**. For the tables this task adds — `skills`,
`mcp_servers`, `files`, `agent_skills`, `agent_mcp_servers`, `agent_files`, `api_keys`,
`secrets`, `audit_events` — it prints columns for exactly one of them (`api_keys`, in §22) and
for none of the rest. It prints columns for `shares`, which belongs to Wave 5 and is not here.

So every column below is a choice. The rule the task was given is "choose the minimum that the
tasks consuming them need", and the consumers are named in the Wave 2 plan: W2-CP-02
(envelope-encrypted secrets, per-agent scoping, write-only API), W2-CP-03 (`ObjectStore` over
filesystem and S3/MinIO), W2-CP-04 (skills as native `SKILL.md` with byte-identical
import/export), W2-CP-05 (MCP connectors whose credentials are secret references), W2-CP-06
(four roles, API keys shown once and stored hashed), W2-CP-07 (durable sessions — needs nothing
new here).

W1-DB-01 set the conventions this task inherits, and its own Consequences section says Wave 2's
schema task "adds files to `schema/`, adds lines to the barrel, and inherits the tenancy test
for free". That is what happened, with one exception: the tenancy test's table inventory was a
hand-written array, and inheriting it for free was exactly what it did **not** do.

---

## Decisions

### 1. The table inventory is derived from the tree, not listed in the test

`tenancy.test.ts` used to pin `EXPECTED_TABLES` as a literal array with the comment "so a Wave 2
table cannot arrive in a Wave 1 branch unnoticed". That worked while there was one wave. It is
the ADR-0015 shape as soon as there are two: the array is something a person has to remember to
update, and the update is mechanical, so the check degrades into a step in a merge conflict.

The expected set now comes from three places that must agree:

* **`migrations/`** — every `CREATE TABLE` the committed migrations apply, minus every
  `DROP TABLE`, walked in the journal's own order. The journal is parsed and validated before it
  is used, and a run that finds no `CREATE TABLE` at all **throws** rather than comparing against
  an empty set.
* **this directory** — one module per table, named after the table (W1-DB-01 decision 1), with a
  `NON_TABLE_MODULES` record naming the modules that define no table and why. The listing comes
  from `git ls-files` and every tracked path in it is classified; see decision 12.
* **the barrel** — what `index.ts` actually exports, which is what `drizzle-kit` reads.

`NON_TABLE_MODULES` runs the opposite way to the literal table list it replaced: it names what is
**not** a table, so a new table file that nobody exported is *unaccounted for* and fails, rather
than being quietly skipped. That is the ADR-0015 direction. It does not decide which files the
gate looks at; decision 12 covers that.

Measured, by deleting each thing in turn and running this file alone:

```
--- deleted `export * from './skills.js';` from schema/index.ts ---
 FAIL  … §27 table inventory, derived rather than listed > exports exactly the tables the committed migrations create
 FAIL  … §27 table inventory, derived rather than listed > has no module that is neither a table nor a recorded helper
 FAIL  … §25 cross-tenant referential integrity > every reference agent_skills makes is either tenant-paired or provably cannot be
      Tests  3 failed | 53 passed (56)

--- removed the 0001_w2_resources entry from migrations/meta/_journal.json ---
 FAIL  … §27 table inventory, derived rather than listed > applies every migration the tree tracks, and tracks every migration it applies
 FAIL  … §27 table inventory, derived rather than listed > exports exactly the tables the committed migrations create
      Tests  2 failed | 57 passed (59)

--- deleted agent_files_file_workspace_fk from schema/agent-files.ts ---
 FAIL  … §25 cross-tenant referential integrity > every *_id column on agent_files is a foreign key or a declared non-reference
      Tests  1 failed | 58 passed (59)
```

(Re-measured in verification round 2, after decision 12 changed this file again. The second
mutation now trips two tests rather than one: dropping the journal entry leaves a tracked
`0001_w2_resources.sql` that nothing applies, which is the case decision 12c added.)

The first case is the mistake a person actually makes. The second is a table that would pass
every other assertion in the repository and fail at deploy time against a real database.

**Downside:** the test now reads the filesystem, so it is coupled to the repository layout. It
walks up from its own directory looking for `migrations/meta/_journal.json` and throws if it does
not find one — a check that cannot locate what it checks fails rather than skipping.

### 2. `skills` stores `SKILL.md` verbatim; description, instructions and allowed tools are not columns

§7 says "Do not invent a proprietary skill format" and "The stored representation should stay
compatible with Claude's native `SKILL.md` structure". §7's detail view lists Name, Description,
Instructions, Supporting Files, Allowed Tools, Assigned Agents — but Description, Instructions
and Allowed Tools are all *inside* `SKILL.md`, as front matter and body.

So `skills` carries `name` (the `.claude/skills/<name>/` directory name, slug-shaped and unique
per workspace), `skill_md` (the file, byte for byte) and `enabled` (§7's "enable/disable it",
which is platform state and not skill content).

*Rejected:* separate `description`, `instructions` and `allowed_tools` columns. They would be
copies of values that also exist in `skill_md`, and no constraint can keep a column in agreement
with a substring of another column — W1-DB-01 decision 6 draws that line, and this is the same
line. It would also put W2-CP-04's byte-identical export at the mercy of a front-matter
serialiser that has to reproduce the author's own quoting and key order.

*Rejected:* storing only a pointer into the `ObjectStore` and no content at all. Listing skills
would then read one object per row.

**Downside, stated:** rendering §7's skill list parses front matter per row. `SKILL.md` is small
and the parse is cheap, but it is work a `description` column would not have needed.

**Supporting files are not rows.** They are objects in the `ObjectStore` — the Wave 2 plan
names the W2-CP-04 → W2-CP-03 edge explicitly — and `ObjectStore.list()` enumerates them. A
`skill_files` table would be a second index of the same directory, able to disagree with it, and
§27 names no such table.

### 3. `mcp_servers` is §8's wizard as columns, and the raw JSON is not stored

§8 prints three transport JSON shapes and a creation wizard (Name / Type / URL-or-Command /
Authentication). The columns are the wizard: `name`, `transport`, `command`, `args`, `url`,
`auth_type`, `credential_secret_id`, `enabled`.

*Rejected:* a `config jsonb` holding the raw MCP JSON. §8 says "Do not expose raw MCP JSON to
normal users. Put raw JSON under an optional 'Advanced' section" — an Advanced view **renders**
the JSON from these columns. A stored second copy could disagree with the fields the wizard edits.

Three CHECKs make the transport rules structural rather than conventions the API layer keeps:
`(transport = 'stdio') = (command is not null)`, `(transport in ('http','sse')) = (url is not
null)`, and `args is null or transport = 'stdio'`. Each is an equivalence in both directions, so
a row that names both a command and a URL, or neither, is rejected — a positive assertion, not a
filter that lets an unclassified row through.

**Not stored:** custom HTTP headers, and per-server environment variables for stdio. Neither is
in §8 and neither is in W2-CP-05's acceptance. Declared as a gap.

### 4. A connector's credential is a reference, and the reference is mandatory exactly when the authentication needs one

§8: "Credentials must not be included directly in normal agent configuration. Store secrets
separately and inject them at runtime." There is therefore no `token`, `api_key` or `password`
column on `mcp_servers` for a caller to reach for. `credential_secret_id` points into `secrets`,
tenant-paired, `ON DELETE RESTRICT`.

`mcp_servers_credential_required` is
`(auth_type in ('api-key','bearer','oauth')) = (credential_secret_id is not null)`. Both
directions again: a connector cannot claim Bearer authentication while storing no credential, and
cannot carry a credential it never uses.

`RESTRICT` rather than `SET NULL` on the secret: nulling the reference would leave a connector
that still claims `auth_type = 'bearer'` — which the CHECK above would reject, so the delete would
fail anyway, but with a constraint name that says nothing about what the operator did. `RESTRICT`
fails at the secret, which is where the operator is.

**This is also the only per-agent secret scoping this wave has.** §23 says "The runtime receives
only the secrets required by that particular agent"; that set is derived by joining
`agent_mcp_servers` to `mcp_servers.credential_secret_id`. §27 names no `agent_secrets` table and
this task did not invent one. A secret that is not attached to a connector has no per-agent path,
and that is declared as a gap on the pull request rather than pre-built.

### 5. `files` is an index of a tree, and a folder is a row

§16: "Files are simply workspace files accessible by the Claude Agent SDK's file tools", with
"upload, download, delete, rename, folders, preview metadata". So: `path` (the whole tree, since
§16 draws `contracts/agreement.pdf`), `kind`, `storage_key`, `size_bytes`, `content_type`.

`kind` exists because "folders" is on §16's list and an **empty** folder has no file beneath it to
imply its existence. *Rejected:* folders as pure path prefixes — then creating a folder and then
uploading into it is not a sequence the UI can perform.

`storage_key` is stored rather than derived from `path`, so a rename is an `UPDATE` of one column
rather than a copy-and-delete in object storage.

Two CHECKs make "inside this workspace" a property of the row: `files_path_shape` requires
slash-separated non-empty segments free of control characters, and `files_path_no_dot_segments`
rejects `.` and `..` anywhere in the path. W2-CP-03's acceptance requires its `ObjectStore` to
refuse traversal by construction; this is the same rule one layer down, for anything that reaches
the table by another route.

**Not stored:** a checksum. Nothing in §16 or in W2-CP-03's acceptance reads one.

### 6. `api_keys.permissions` is a role, not a scope list

§22 lists `permissions` among an API key's fields and says nothing about its shape. §21 says
"Keep authorization simple", gives four roles, adds "Sharing rights follow the same four roles and
add nothing new", and says "Do not implement an enterprise IAM product".

So a key acts with one of §21's four roles, and the permission split W2-CP-06 implements for a
member is the split a key gets.

*Rejected:* `permissions jsonb` holding a scope list. It is a second authorization vocabulary
that every route would have to understand **in addition to** the first, and W2-CP-06's acceptance
is an authorisation matrix over four roles — a key with scopes would not be a row in that matrix.

**Downside, stated:** a key cannot be narrower than a role. "Read-only key that can also rotate
one connector" is not expressible. Widening this later means adding a column, not changing one.

The hash algorithm is **not** pinned here. §22 says "Store only a secure hash"; research note
R-12 is deciding the algorithm and W2-CP-06 implements it, so `key_hash` carries a not-blank CHECK
and no shape CHECK. A `^[0-9a-f]{64}$` constraint would have been this task pre-empting R-12 with
a migration.

### 7. `secrets` is shaped so that storing a plaintext is awkward

The brief asks for a shape that makes storing a plaintext secret awkward rather than possible.
Four properties do that, and each is a positive assertion the row has to satisfy:

1. **No column a plaintext fits.** Every value-bearing column is `bytea`, so a caller holding a
   `string` has to encode it deliberately.
2. **The envelope's fixed-size parts are CHECKed to their exact sizes** —
   `octet_length(wrapped_data_key) = 32`, both nonces `= 12`, both tags `= 16`. A row that is
   missing a part, or carries one at the wrong size, is refused **by constraint name**. This
   asserts the parts are present and correctly sized and asserts nothing about where the bytes
   came from — see "the honest limit" below, which this bullet contradicted in an earlier
   revision of this record.
3. **`master_key_id` is NOT NULL and non-blank**, so rotation is a re-wrap of data keys rather
   than a re-encryption of every value, and a row nobody can decrypt cannot be written.
4. **`algorithm` is a closed set with one member.** Widening it is a deliberate CHECK change, not
   a silent reinterpretation of existing rows.

`drizzle-orm@0.45.2` ships no `bytea` builder — `drizzle-orm/pg-core/columns/` has `bigint`,
`boolean`, `char` and so on and nothing named `bytea`, `blob` or `binary` — so `columns.ts` adds
one with `customType`. `pg` already maps `bytea` to a `Buffer` in both directions, so no
conversion functions are declared; an identity conversion would only be a place for the two
directions to disagree.

**The honest limit, stated because a reader will otherwise assume more:** no database constraint
can prove a ciphertext is a ciphertext. AES-256-GCM output is the same length as its input, so a
row whose `ciphertext` is a plaintext of any length, accompanied by fabricated fixed-size
companions, is accepted. Measured against `postgres:17-alpine` (17.11) with this migration
applied:

```
$ docker exec -i rp-w2db01-pg psql -U postgres -d rpdb
INSERT INTO secrets (workspace_id,name,algorithm,master_key_id,wrapped_data_key,
  wrapped_data_key_nonce,wrapped_data_key_tag,ciphertext,ciphertext_nonce,ciphertext_tag)
 SELECT id,'PLAINTEXT_TOKEN','aes-256-gcm','mk1',
  decode(repeat('00',32),'hex'), decode(repeat('00',12),'hex'), decode(repeat('00',16),'hex'),
  convert_to('sk-ant-super-secret-value','UTF8'),
  decode(repeat('00',12),'hex'), decode(repeat('00',16),'hex')
 FROM workspaces WHERE slug='repro';
INSERT 0 1

SELECT name, convert_from(ciphertext,'UTF8') AS stored_plaintext
  FROM secrets WHERE name='PLAINTEXT_TOKEN';
      name       |     stored_plaintext
-----------------+---------------------------
 PLAINTEXT_TOKEN | sk-ant-super-secret-value
(1 row)
```

An all-zero 32-byte wrapped key and two all-zero 16-byte tags were produced without running any
cryptography, and nothing refused the row. `seed.test.ts`'s own `goodEnvelope` fixture is the
same counterexample and the suite requires it to be accepted.

So the claim is narrowed to the one that is true: the shape asserts that all seven envelope parts
are present, correctly sized, and name a master key. It does not make a caller run AES-256-GCM,
and any sentence saying it does — including one this record carried three bullets above until
verification round 1 — is withdrawn. What the shape buys is that a plaintext cannot be stored
*inadvertently*: there is no column it fits, and seven correctly sized companions have to be
invented on purpose. The encryption itself is W2-CP-02's, and its acceptance — "a secret value
appears in no API response, no log line and no audit row" — is where it is proved.

*Rejected:* one `bytea` column holding a concatenated nonce‖tag‖ciphertext blob. It is fewer
columns and no constraint can check any part of it.

*Rejected:* `text` columns holding base64. A `text` column accepts a plaintext without complaint,
which is precisely the property this table must not have.

### 8. `audit_events` stores labels, not joins, and has no metadata blob

§36 gives an action list and one rendered line: "Ito changed Customer Support Agent / 2 minutes
ago". The columns are that line: `actor_user_id`, `actor_label`, `action`, `subject_id`,
`subject_label`, `created_at`.

* **The labels are stored.** An audit line that changes retroactively — because the agent was
  renamed, or the user deleted — is not a record. This is `runs.model`'s argument from W1-DB-01
  decision 6, applied to a name.
* **`actor_user_id` is `ON DELETE SET NULL`.** "user deleted" is itself on §36's list, so a trail
  that forbade deleting an audited user would forbid the action it exists to record.
* **`subject_id` is `text` and carries no foreign key.** The subject of "agent deleted" does not
  exist by the time anyone reads the row. Typing it `text` says so, and a CHECK holds it to the
  shape of this schema's ids. It is declared in `tenancy.test.ts`'s `NON_REFERENCE_ID_COLUMNS`
  with that reason — see decision 11, which is where the rule it interacts with now lives. An
  earlier revision of this bullet said the `text` typing kept that rule *strict*; it did the
  opposite, and decision 11 is the repair.
* **There is no metadata JSONB.** §36's own instruction after the list is "Do not log secrets",
  and a free-form blob on an audit row is where a request body ends up.

`audit_actions` is §36's list, verbatim and in §36's order, slugified so `oneOf` can inline it.
Five of the values name objects no table in this wave holds — runtime profiles are Wave 3's,
projects and shares are Wave 5's. They are in the set anyway: the column is not a foreign key, and
leaving them out would mean a later wave editing this file to add a value the specification
already printed.

### 9. `updated_at` exists where a column can change, and nowhere else

`agent_skills` and `agent_mcp_servers` carry `created_at` only: a link is created or removed and
never edited. `agent_files` carries both, because §16's "read-only or read-write access" is an
`access` column a grant can be narrowed or widened in. `audit_events` carries `created_at` only,
because the row is immutable.

*Rejected:* `updated_at` on every table for symmetry with W1's. A timestamp nothing can move is a
column that tells a reader something untrue — the HANDOFF §7 failure mode, in a schema.

### 10. Not added: `projects`, `project_files`, `project_mcp_servers`, `shares`, `share_views`, `runtime_profiles`

The Wave 2 plan assigns the first five to W5-DB-01 and `runtime_profiles` to Wave 3.
Pre-creating them would claim ownership of files a later wave's task is dispatched to write.
`shares` is the one table §27 gives columns for, which makes it the tempting one; it is still not
this task's.

### 11. The "every reference is declared" rule is over every `*_id` column, at any SQL type

*Taken in verification round 1, in response to the major finding on PR #37 and under
[ADR-0027](0027-a-partition-that-lists-its-members-has-not-been-partitioned.md), which arrived on
this branch's base while the round was in progress.*

The rule as this task first shipped it read:

```ts
.columns.filter((column) => column.getSQLType() === 'uuid' && column.name.endsWith('_id'))
```

That is a FILTER applied to a derived set. ADR-0027 decision 3 is titled "A filter is not a
classifier", and its worked example ends: "Used to *classify*, with an `else` that throws, it
cannot. Every regex applied to a tracked-tree listing in a gate is a classifier, and the difference
is one `else`." Membership in what the gate inspected was therefore a property the schema author
chose. A tenant-scoped table could carry an unpaired, undeclared cross-tenant reference by typing
its id column `text`.

ADR-0027 decision 1 is written about **files** — `git ls-files -- <dir>` plus a filename rule. The
members of *this* gate are **columns**, which `getTableConfig` reads from the schema objects the
barrel exports, so there is no `git ls-files` to apply at this level; what decision 1 asks for here
is that the set be derived rather than listed, and that is what the shape rule below does. The
file-level listings this test also performs are a separate matter, and they were still working-tree
`readdirSync` filters after this decision; decision 12 is where they are dealt with.

Measured, before the change, on this branch. A fabricated `attack_notes` table with
`workspace_id` (NOT NULL, foreign key to `workspaces`, leading an index) and a bare
`agent_id: text('agent_id').notNull()` with no foreign key at all:

```
$ npx vitest run packages/core/src/db/schema/tenancy.test.ts --reporter=dot
 Test Files  1 passed (1)
      Tests  60 passed (60)
```

The same table with `agentId: uuid('agent_id')` and no foreign key failed. `text` versus `uuid`
was the whole difference between green and red. Decision 8's bullet and `audit-events.ts`'s
module header both described that typing as keeping the rule *strict*, which is the opposite of
what it did, and this PR shipped the first column to use it.

**The repair.** The contributing set is derived by shape: every column whose name ends in `_id`,
on every table the barrel exports, at any SQL type. Each member is then CLASSIFIED into one of
two buckets, and the `else` REJECTS by name:

1. covered by a foreign key — a live reference, whose tenant pairing the rule above then judges;
2. declared in `NON_REFERENCE_ID_COLUMNS` with its SQL type and the reason it refers to nothing
   in this schema;
3. **anything else is a hard failure naming `table.column`,** and the failure message prints the
   derived set for that table — ADR-0027's first consequence, "a gate's failure output must now
   print the derived set, because a reader can no longer find it by reading a literal".

`NON_REFERENCE_ID_COLUMNS` is a registry, and the objection to registries is the one ADR-0027
raises: a literal that enumerates a partition has not partitioned it. This one runs the other way,
like `NON_TABLE_MODULES` in decision 1. It does not decide what the gate inspects — the shape rule
does that, and it inspects everything. An entry only records why a member that the gate already
found is legitimately unpaired. Nobody has to remember to add one, because forgetting is a hard
failure. It has three entries today, and the gate derives them, not the record:

* `audit_events.subject_id` (`text`) — a dead identifier, §36; decision 8.
* `secrets.master_key_id` (`text`) — names a deployment key that lives outside the database.
* `sessions.claude_session_id` (`text`) — the Agent SDK's own resume token, minted elsewhere.

The last of those is W1's, and it is the evidence that the hole predates this PR: it was already
invisible to the gate, and nothing recorded that.

The entries are themselves checked, in both directions. Each pins the column's SQL type, so
retyping the column invalidates the declaration and forces the decision to be re-taken; a
declaration on a column that IS covered by a foreign key fails as dead; and a separate assertion
rejects an entry naming a table the barrel does not export or a column the table does not have.

Measured, after the change. Both mutations were re-run in verification round 2 against the tree
decision 12 left behind, and this is that transcript:

```
--- baseline ---
      Tests  59 passed (59)

--- the same fabricated attack_notes table, agent_id typed `text`, with its migration ---
 FAIL  … §25 cross-tenant referential integrity > every *_id column on attack_notes is a foreign key or a declared non-reference
 AssertionError: attack_notes: attack_notes.agent_id (text) is named like a reference, is covered
 by no foreign key, and is not declared in NON_REFERENCE_ID_COLUMNS. Either give it a foreign key,
 or declare it there with its SQL type and the reason it refers to nothing in this schema.
 The *_id columns this gate derived on attack_notes: workspace_id uuid, agent_id text
      Tests  1 failed | 61 passed (62)

--- renamed `sessions.claude_session_id` to `sessions.no_such_id` in the registry ---
 FAIL  … > every *_id column on sessions is a foreign key or a declared non-reference
 AssertionError: sessions: sessions.claude_session_id (text) is named like a reference, is covered
 by no foreign key, and is not declared in NON_REFERENCE_ID_COLUMNS … The *_id columns this gate
 derived on sessions: workspace_id uuid, user_id uuid, agent_id uuid, claude_session_id text
 FAIL  … > declares no non-reference *_id column that is stale or misnamed
 AssertionError: sessions.no_such_id names a column sessions does not have. Declared
 non-references: audit_events.subject_id, secrets.master_key_id, sessions.no_such_id
      Tests  2 failed | 57 passed (59)
```

Both mutations were reverted, and `git status --porcelain` showed nothing of them afterwards.

**Downside, stated:** the rule is now keyed on a naming convention. A cross-tenant reference in a
column that is not named `*_id` — `owner`, `parent` — is still outside it. That is a real limit
and it is declared on the pull request rather than implied away; closing it would mean deriving
"is a reference" from something other than the name, and nothing in Drizzle's metadata offers
that for a column with no foreign key.

### 12. The file-level listings in `tenancy.test.ts` read the tracked tree and classify it

*Taken in verification round 2, under
[ADR-0028](0028-the-classifier-rule-is-applied-by-enumeration-not-at-the-site-named.md). Decision
11 fixed the column rule and left the two listings one level above it — the schema directory and
the migration text — as filters over a working-tree listing and over the migration text. A fresh
verifier found both; the third below came out of the enumeration ADR-0028 requires.*

Three sites, each reproduced before it was changed and after:

**a. The schema-module listing.** It read
`readdirSync(SCHEMA_DIR).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))`.
Two faults in one line: the set came from the working directory rather than from `git ls-files`,
and the narrowing was a filter with no `else`. A tracked `attack-helper.mts` in the schema
directory — a module exporting no table, recorded in no list — left the file green at
`Tests 58 passed (58)`. It is now `git ls-files` plus a classifier: a tracked path there is a test
module, a schema module, or a hard failure naming the file, and the failure prints the modules it
did derive. The same file, tracked, now fails three tests.

**b. The `CREATE TABLE` / `DROP TABLE` operand.** The patterns were
`/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/giu` — an identifier pattern used to filter
the migration text, so only double-quoted identifiers contributed. Appending an unquoted
`CREATE TABLE attack_notes (…)` to `0001_w2_resources.sql` left the file green at
`Tests 58 passed (58)`: a table a committed migration creates and nothing exports raised nothing.
Every `CREATE TABLE` in the migrations committed at the time was quoted, so this was latent rather
than live, and latent is not a reason to leave a filter in a gate. A classifier now reads each
operand: quoted, unquoted (folded to lower case, as PostgreSQL folds it), or a hard failure naming
the text. `CREATE TABLE attack_notes AS SELECT 1 AS one;` is a failure rather than a silence.

This fixed the *operand* half and left the *statement* half — which statements the reader looks at
at all — as it was. That half is decision 13. No count of the `CREATE TABLE` lines is written here:
under [ADR-0016](0016-measured-numbers-do-not-live-in-prose.md) decision 4 a number in prose has
to carry its commit and date, and a count that the next migration invalidates is the medium
decision 5 asks a verifier to report rather than the fact.

**c. The migration set itself.** The tables were derived by walking the journal, so a committed
`.sql` the journal does not list contributed nothing and no rule noticed. The tracked `.sql` files
and the journal's tags are now derived separately and compared, and every tracked path under
`migrations/` is classified as migration, snapshot or journal with an `else` that names anything
else.

**Not converted, declared instead.** `getTableConfig(table).columns.filter((column) =>
column.name.endsWith('_id'))` — the rule of decision 11 — is still a filter over a column list, and
that is deliberate: its subject *is* the naming convention, and a reference held in a column named
`owner` cannot be recognised from Drizzle's metadata at all. The remaining narrowings in the file
are enumerated on the pull request, each converted or declared with the reason, which is what
ADR-0028 asks for.

**Downside, stated:** the file now shells out to `git`. A checkout without git, or a copy of the
tree that is not a repository, fails this gate rather than passing it — which is ADR-0015's
direction, but it is a new dependency, and it is why `trackedPathsIn` throws with the directory
named rather than returning an empty list. An untracked file in the schema directory is now
invisible to the gate by design: it is not part of the branch, and CI checks out the index.

### 13. The migration cross-check classifies STATEMENTS, and refuses one it cannot place

*Taken in verification round 3, under
[ADR-0029](0029-a-narrowing-is-a-defect-only-when-a-counter-example-exists.md). Decision 12b
converted the operand and left the statement selection alone, and a fresh verifier built the
counter-example for the half that was left.*

`migratedTableNames()` found its statements by running `CREATE_TABLE` and `DROP_TABLE` over the
whole file with `matchAll`. Those two patterns decided which statements participated, so every
other statement in a committed `.sql` contributed nothing and nothing said so. The counter-example
the verifier ran, and which reproduces on the commit decision 12 shipped: appending
`ALTER TABLE "skills" RENAME TO "abilities";` to `0001_w2_resources.sql` left `tenancy.test.ts`
fully green, while the deployed database would hold `abilities` and the barrel would still export
`skills` — the exact failure the `exports exactly the tables the committed migrations create`
assertion says it exists to catch. `drizzle-kit` emits that statement itself for a table rename.

The file is now split into statements and each statement is classified. `migrationStatements()`
splits on the top-level `;`, consuming string literals, quoted identifiers, dollar-quoted blocks
and both comment forms as units and throwing on an unterminated one, so every statement in the
file reaches the classifier. `classifyStatement()` returns one of four verdicts —
*creates-tables*, *drops-tables*, *renames-a-table*, or *leaves-the-table-set-alone* with the
reason it cannot change the set — and ends in an `else` that throws naming the statement. A rename
is applied to the derived set rather than merely rejected, and a rename of a table no earlier
migration creates throws.

`TABLE_SET_NEUTRAL` and `ALTER_TABLE_SHAPE_ONLY` are the classifier's positive cases, not a list of
members: each entry carries the reason its form cannot change which tables exist, and a form that
is in neither and has no branch of its own is rejected rather than assumed harmless.
`ALTER TABLE … SET SCHEMA` is deliberately absent
from the second list — this reader strips schema qualifiers, so it would read as a no-op when it is
not one.

Measured on this branch, appending one statement to `0001_w2_resources.sql` and running
`npx vitest run packages/core/src/db/schema/tenancy.test.ts`:
`ALTER TABLE "skills" RENAME TO "abilities";` fails the inventory equality;
`SELECT * INTO "attack_notes" FROM "skills";` and `ALTER TABLE "skills" SET SCHEMA "other";` fail
with the classifier's refusal; `ALTER TABLE "skills" RENAME COLUMN "name" TO "title";` and
`CREATE INDEX "x" ON "skills" ("name");` stay green.

**Round 4 — `CREATE SCHEMA` was one of those entries and its stated reason was untrue.** The entry
read "creates a schema; the tables in it are created by their own statements". PostgreSQL's
documented `CREATE SCHEMA` syntax takes an optional schema-element list, `CREATE TABLE` is one of
the element forms that list accepts, and the whole thing is one statement, so the sentence was
false and the verdict it justified let a hand-written migration create a table no schema module
exports. `CREATE SCHEMA`
is no longer a `TABLE_SET_NEUTRAL` pattern: it is classified by its own branch, which gives the
neutral verdict only when the statement text ends at the header — `[IF NOT EXISTS]`, an optional
schema name, an optional `AUTHORIZATION <role>` — and throws otherwise, because reading the element
list means implementing a second statement grammar that has no terminators in it. Measured, by the
same append-one-statement method as above:
`CREATE SCHEMA "hollywood" CREATE TABLE "attack_notes" ("title" text);` and
`CREATE SCHEMA AUTHORIZATION "joe" CREATE TABLE "attack_notes" ("title" text);` now fail with the
classifier's refusal, where before this round both left the suite green;
`CREATE SCHEMA "hollywood";`, `CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION "joe";` and
`CREATE SCHEMA AUTHORIZATION "joe";` stay green. The transcripts are in the pull request.

`CREATE EXTENSION` was removed in the same round for a reason it does not share. Its entry read
"loads an extension; it creates no table this schema owns". An extension's install script is
ordinary SQL and may create tables — PostGIS ships `spatial_ref_sys` — and this gate executes no
SQL and opens no extension, so what a given `CREATE EXTENSION` creates is not something it can
find out and no entry could state truthfully that the form creates no table. That much is argued
rather than measured; what was measured is that removing the entry costs nothing here, because
`grep -rn "CREATE EXTENSION" migrations/` returns no line, and that the form is now refused —
appending `CREATE EXTENSION IF NOT EXISTS "postgis";` fails with
`is a statement this gate cannot classify`. The first migration that needs an extension has to
argue for it.

**Downside, stated:** this gate now rejects any SQL form it has not been taught. A migration using
a statement kind neither list names fails CI until somebody adds the form with a reason. That is
the direction ADR-0015 asks for and it is also friction, and the friction lands on whoever writes
the next hand-edited migration rather than on the person who introduced the hole. Round 4 widened
that friction: a `CREATE SCHEMA` carrying elements and any `CREATE EXTENSION` now fail too.

**Not converted, and no counter-example exists.** Two narrowings the same verifier raised were
tried against ADR-0029 and could not be turned into one.

`if (name !== undefined) leading.push(name)` in `leadingIndexedColumns` feeds containment
assertions — `toContain('workspace_id')` and `arrayContaining([…])` — and containment is monotone
in the list, so a dropped entry can only make the gate fail. Measured, by making the tenant index
of `audit_events` functional so its leading entry becomes a `SQL` expression and is dropped:

```
AssertionError: audit_events.workspace_id leads no index, so every tenant-scoped query is a
sequential scan: expected [ 'actor_user_id' ] to include 'workspace_id'
      Tests  1 failed | 58 passed (59)
```

The narrowing turned a table that has the index into one the gate rejects. It cannot turn a table
that lacks it into one the gate accepts, which is what a counter-example would have to be.

The bounded `cause` walk in `seed.test.ts` ends in `expect(seen, …).toContain(constraint)`, the
same monotone shape, so a dropped or unreached entry can likewise only make it fail. That one is
argued rather than measured: the assertion it feeds runs only when `TEST_DATABASE_URL` names a
reachable PostgreSQL, which the repair worktree had none of. CI does provide one. Both narrowings
are recorded on the pull request rather than changed.

---

## Alternatives considered

Each decision above carries its own rejected alternatives. Two are worth repeating because they
were the closest calls:

* **A `description` column on `skills`.** It would make the skill list a single query with no
  parsing. It lost because nothing could keep it in agreement with the same value inside
  `skill_md`, and W1-DB-01 already ruled that a denormalised copy is acceptable only when a
  constraint enforces it.
* **An `agent_secrets` join table.** It would give §23's "only the secrets required by that
  particular agent" a direct representation. It lost because §27 names three `agent_*` join
  tables and not a fourth, the brief's table list does not include it, and the connector path
  already derives a per-agent secret set. It is named as a gap instead, so W2-CP-02 can ask for it
  with evidence rather than find it pre-built and unused.

---

## Consequences

* W2-CP-02 inherits a column contract it did not write. If AES-256-GCM is not what it implements,
  the CHECK constraints in `secrets` are a migration it must change — deliberately, which is the
  point of the closed `algorithm` set.
* W2-CP-05 cannot store a raw credential on a connector row even by mistake; there is no column
  for one, and `mcp_servers_credential_required` refuses a connector that claims authentication
  without a reference.
* W2-CP-04 gets byte-identical `SKILL.md` round-tripping for free and owes byte fidelity only for
  supporting files, which is the `ObjectStore`'s job.
* W2-CP-06 gets four-role API keys and must not introduce a second permission vocabulary without
  reversing decision 6.
* W5-DB-01 adds `shares` with §27's own column list and inherits the derived inventory: its tables
  are covered by `tenancy.test.ts` the moment they are exported, and its migration is checked
  against its schema without anybody editing a list.
* Any later wave adding a `*_id` column that is not a foreign key must add an entry to
  `NON_REFERENCE_ID_COLUMNS` with a reason and the column's SQL type (decision 11). It will not be
  able to skip that step: the gate fails naming the column.
* The acceptance evidence for this task was produced against `postgres:17-alpine` (17.11) in
  Docker, not against a mock.
* One file outside the declared `Owns` globs was touched: `docs/adr/README.md`, which is generated
  — adding this record makes the committed index stale and `sh docs/adr/regenerate-index.sh
  --check` is a blocking CI step, so the script was re-run rather than the table edited. It is
  declared on the pull request, as W1-DB-01 declared it.

## Honest downsides, collected

1. The skill list parses front matter per row instead of reading a column.
2. An API key cannot be narrower than one of §21's four roles.
3. `secrets`' constraints assert that all seven envelope parts are present and correctly sized,
   and nothing about where the bytes came from. Constant bytes pass; measured in decision 7.
4. A secret not referenced by a connector has no per-agent scoping path in this wave.
5. `tenancy.test.ts` now reads the filesystem, so moving `migrations/` or renaming a schema module
   breaks it — loudly, which is the intent, but it is a new coupling.
6. `mcp_servers` stores no custom headers and no stdio environment, so a connector needing either
   cannot be expressed until a later wave adds a column.
7. The "every reference is declared" rule (decision 11) is keyed on the `*_id` name. A cross-tenant
   reference in a column named `owner` or `parent` is outside it.
8. `.github/workflows/ci.yml` carries three measured counts in comments that this branch makes
   false. It is outside this task's `Owns` globs; see the pull request's gap list, which names the
   lines and the owner.
9. `tenancy.test.ts` now runs `git ls-files` (decision 12). It needs a git checkout, and it fails
   rather than skips without one.
10. The migration cross-check (decision 13) rejects any SQL statement form that neither
    `TABLE_SET_NEUTRAL` nor `ALTER_TABLE_SHAPE_ONLY` names and that has no branch of its own. A
    hand-written migration using an unfamiliar form fails CI until somebody adds the form with a
    reason, and that friction lands on the next migration author. Round 4 added two more refusals:
    a `CREATE SCHEMA` whose text does not end at its header, and every `CREATE EXTENSION`.
11. `mcp_servers.args` is guarded by nothing at run time. `$type<McpArgs>()` is a compile-time
    hint, the column carries no `jsonb_typeof` CHECK, and `parseMcpArgs` is a parse the schema
    offers rather than one this branch applies anywhere. Round 2 found this branch's prose
    describing it as the control every read goes through; that sentence was wrong and is gone.
    The pull request declares the column, and W2-CP-05 is the first consumer that has to close it.
