# ADR-0166 — An app blueprint is a versioned release of app parts, received as a proposal

Status: accepted
Date: 2026-11-02
Decided by: the implementing agent of U7.1 (issue #1532, agent portal programme, tracker #1476), on the Owner's delegation for the programme
Scope: `packages/sdk/src/project/blueprint.ts` (new), `packages/sdk/src/project/generated-manifest.ts`, `packages/aw/src/commands/` (a new `blueprint` family), `packages/aw/src/generate/destroy.ts`, `packages/aw/src/project/load.ts`; issue #1533 builds it

## Context

The agent-portal plan (F-8) asks for parts of an app that can be shared and versioned: a resource
with its pages, its agent tools and its recipes, released by one team and received by another app.
The other app receives each new version as a proposal it previews and accepts. Generated code
belongs to the customer once it is written, so a new version must never overwrite it silently.
The portal implementation guide names three layers: the platform (layer 1), the app kit and the
CLI (layer 2), and the customer's own app code (layer 3). Shared parts are layer-3 code, moved by
layer-2 tools.

### What exists

- **Starters.** `packages/sdk/src/project/starters/{automation,copilot,knowledge,review,support}`
  are the nearest thing to shareable parts. `renderProjectFiles`
  (`packages/sdk/src/project/render.ts`) renders them once, at `create` or `init` time. They have no
  version and no update path.
- **One template renderer (R-F4).** `renderTemplateDirectory` (`packages/sdk/src/project/template.ts`)
  renders a directory of real files. It replaces `{{key}}` in text and `__key__` in paths, drops a
  trailing `.template.txt`, and refuses a `{{key}}` that has no value.
- **The generated-file manifest.** `aw-generated.json` (`packages/sdk/src/project/generated-manifest.ts`,
  issues #1505, #1507, #1531) is strict, version 1. Its entries are keyed `<kind>:<name>`, and the
  kinds are `app`, `resource`, `agent`, `page`, `recipe`, `channel` and `project`. Each entry lists
  the sha256 of every file it wrote, and the one-line edits it made to files it did not write:
  an `app.config.ts` import from `appConfigLines` or `appConfigRecipeLines`, a `package.json` pin,
  or a migration-journal entry. Comparing a file with its recorded hash tells generated code from
  code a developer has edited. That comparison is what makes a three-way update possible: the
  installed version, the new version, and the local edits.
- **Plan first.** `aw destroy <kind> <name>` shows its plan and acts only with `--yes`, and it
  refuses a file edited since it was generated (ADR-0114 S2). `aw deploy` without `--yes` plans, and
  a plan with changes exits 3 through `ChangesPendingError`
  ([ADR-0094](0094-agent-workspace-deploy-wraps-compose-helm-and-terraform-plan-first.md)).
- **The portable agent file.** [ADR-0133](0133-one-portable-agent-definition-exports-to-many-agent-platforms.md)
  D3 makes `agents/<name>.agent.md` the interchange file: YAML front matter, with the Markdown body
  as the instructions, read and written by `parseAgentMarkdown` and `formatAgentMarkdown`
  (`@indx-workspace/sdk/portable`). ADR-0133 D4 makes every credential a reference only. Today only
  `aw platforms import` writes such a file and only `aw platforms export` reads one. The project
  loader behind `aw push` and `aw dev` reads `agents/*.ts` only.
- **The app kit is reached only through its bin.** `aw` may import only the SDK and the contracts
  (`aw-depends-only-on-sdk-and-contracts`). App-kit work runs in the project's own `aw-app` bin,
  which is pinned in lock-step with `aw` (`packages/aw/src/generate/app-kit.ts`).
- **Generated migrations carry the app's schema.** `aw generate resource` writes
  `db/migrations/<NNNN>_create_<plural>.sql`, in which every table is qualified as `"app_<app>"."…"`,
  and appends a journal entry. `pnpm migrations:lint` refuses DDL that is not expand-only.

### The word is taken

"Blueprint" already names the product design review of 2026-10-04 ("the blueprint decisions Q1 and
Q8", "the blueprint review of 2026-10-04") in
[ADR-0101](0101-the-platform-owns-agent-versions.md),
[ADR-0103](0103-one-project-file-holds-every-environment.md),
[ADR-0104](0104-a-team-is-a-resource.md) and
[ADR-0108](0108-the-frontend-is-a-four-rung-ladder-and-a-configuration-agent-edits-it.md). An
unqualified F-8 "blueprint" would make those citations ambiguous.

## Options

### Option A — An npm-packaged release of app parts, installed and updated as a plan-first proposal (recommended)

A blueprint is an npm package that holds code and binding shape, never data or credentials. `aw`
fetches it with integrity checked. It renders the parts through the one renderer, records them in
`aw-generated.json`, and on update proposes a per-file plan. A file the developer edited is never
overwritten.

### Option B — Version the starters

Give `create`'s starters a version and an update path. This keeps the parts inside this
repository's release, so a team cannot publish its own. Starters are also whole projects, not parts
an existing app adds. Rejected.

### Option C — A git URL plus a tag

Fetch the parts from a git repository at a tag. A tag can be moved, so there is no integrity pin
without extra machinery: a commit hash, a signature check, and our own cache. Private hosting would
need a second credential path beside the registry the project already uses. Rejected.

### Option D — A hosted registry service

The platform hosts and lists blueprints. This is a marketplace, which the [specification](../spec.md)
lists as a non-goal (§38). It would also give the platform (layer 1) a table and a route for
something that is layer-3 code. Rejected.

## Recommendation

Option A, with the decisions below. #1533 builds them without further design.

### D1 — Vocabulary: "app blueprint" in prose, `blueprint` in code and on the command line

- Prose says **app blueprint** the first time in a document, and "blueprint" after that where the
  context is plain. Code, the CLI, the manifest file and the manifest kind say `blueprint`.
- The citations "the blueprint, decision Q…" and "the blueprint review of 2026-10-04" in ADR-0101,
  ADR-0103, ADR-0104 and ADR-0108 mean the product design document of 2026-10-04, not an app
  blueprint.
- "Kit" is rejected: it collides with "app kit" (`@indx-workspace/app`), and an app kit is exactly
  what a blueprint is not.

### D2 — Contents: code and binding shape only

A blueprint package contains, beside its `package.json`, only these:

| Part kind   | Path in the package           | Lands at                                  |
| ----------- | ----------------------------- | ----------------------------------------- |
| `resource`  | `resources/<name>.ts`         | the same path                             |
| `recipe`    | `recipes/<name>.ts`           | the same path                             |
| `page`      | `app/**` (pages and routes)   | the same path                             |
| `agent`     | `agents/<name>.agent.md`      | the same path                             |
| `skill`     | `skills/**`                   | the same path                             |
| `test`      | `tests/**`                    | the same path                             |
| (migration) | `migrations/<NNNN>_<tag>.sql` | `db/migrations/<next>_<tag>.sql` (D6, D8) |
| manifest    | `blueprint.json`              | not written (D5)                          |

- Pages are built from app-kit parts (`@indx-workspace/app`), like the pages `aw generate` writes.
- An agent travels only as an ADR-0133 D3 `agents/<name>.agent.md` file, never as `defineAgent`
  TypeScript, so the agent part stays portable and secret-free.
- A blueprint **never** contains rows or other data, uploaded files, `.env` files, secret values,
  connector URLs, tokens, `app.config.ts`, `package.json` edits, `agent-workspace.yaml`, or an
  `agents/<name>.ts`. Its parts are text; a binary file is refused.

### D3 — Binding shape: slots the installing app binds

`blueprint.json` names the **slots** its parts refer to. The parts refer to each slot by its name.

- `connectors: [{ slot: 'email', kind: 'mcp', identity: true }]`: a connector of that name in the
  installer's `agent-workspace.yaml`. `kind` is `mcp`, the only connector kind the project file has.
  `identity: true` says the parts need the signed identity assertion
  ([ADR-0142](0142-tools-learn-who-is-asking.md)).
- `secrets: [{ slot: 'crm_api_key' }]`: a secret **reference** in the `SecretNameSchema` grammar,
  never a value
  ([ADR-0133 D4](0133-one-portable-agent-definition-exports-to-many-agent-platforms.md)).
- `agents: [{ name: 'triage' }]`: the agents the blueprint creates. Each needs an
  `agents/<name>.agent.md` part.

Binding happens only in the installer's `agent-workspace.yaml`, and never in the blueprint. `aw`
does not edit that file: a connector's URL and identity differ by deployment. The install plan lists
each slot as `bound`, when the project file already defines it, or `to bind`, with the YAML lines to
add. A slot left unbound surfaces where any missing connector or secret does today: when the agent
is checked or pushed, or when the app first reads it.

### D4 — Packaging, distribution and fetching: an npm package

- A blueprint is an **npm package** with `blueprint.json` at its root and
  `"keywords": ["indx-workspace-blueprint"]`. Its version, any private registry and its
  authentication come from npm and the developer's `.npmrc`.
- A blueprint is **not** added to the app's `package.json` or its lockfile. It is source the app
  copies, not a runtime dependency. Its pin is the `source` record in `aw-generated.json` (D6).
- **Fetching.** `aw` runs `npm pack <spec> --json --ignore-scripts` in a new temporary directory,
  with the project's environment. It reads `filename` and `integrity` from the JSON. Before it reads
  the tarball, it computes the tarball's sha512 and compares it with `integrity`. On update and diff
  of the installed version (D7), the integrity must also equal the one recorded at install. Install
  scripts never run.
- **Reading.** A pure reader in the SDK (`readBlueprintArchive`) takes the gunzipped tar bytes
  (`aw` gunzips them with `node:zlib`; no new dependency). It refuses:
  - a symbolic link, a hard link, or any entry that is not a regular file or a directory;
  - an absolute path, a `..` segment, a backslash or a NUL;
  - any file outside `package/`;
  - any file other than `package.json`, `blueprint.json`, a top-level `README*`, `LICENSE*` or
    `CHANGELOG*`, and the parts and migrations `blueprint.json` lists;
  - a listed part that is missing;
  - more than 200 files (the manifest's per-entry limit) or more than 5 MiB in all.
- **Rejected:** a git URL plus a tag (Option C) and a hosted registry (Option D).

### D5 — The manifest schema: strict, homed in the SDK

`blueprint.json` is parsed by a strict Zod schema (unknown keys refused) in
`packages/sdk/src/project/blueprint.ts`, beside the renderer and the generated-file manifest:

```json
{
  "name": "helpdesk",
  "version": "1.2.0",
  "appKit": "^0.9.0",
  "parts": [{ "path": "resources/ticket.ts", "kind": "resource" }],
  "slots": { "connectors": [], "secrets": [], "agents": [] },
  "migrations": ["migrations/0000_create_tickets.sql"]
}
```

- `name` follows the manifest's entry-name grammar (`[a-z0-9][a-z0-9_-]{0,63}`). It names the entry
  `blueprint:<name>` and the CLI argument. It is not the npm package name.
- `version` is an exact semver and must equal the package's `package.json` version.
- `appKit` is the range of `@indx-workspace/app` the parts are written for. The grammar is an exact
  version, `^x.y.z` or `~x.y.z`, with npm's meaning (on `0.x`, `^0.9.0` is `>=0.9.0 <0.10.0`). A
  pre-release matches only exactly. No other range form, and no new semver dependency.
- `parts[].kind` is one of D2's kinds, and the path must lie under that kind's root.
- `migrations` is ordered, and is not repeated in `parts`.
- `aw` imports the schema and the pure helpers from `@indx-workspace/sdk/project`. `aw` never
  imports `@indx-workspace/app`; the installed app-kit version is read from the project's own
  `node_modules/@indx-workspace/app/package.json`, as `app-kit.ts` already finds it.

### D6 — Install: `aw blueprint add <npm-spec> [--yes]`

1. **Fetch and verify** as D4 says, and parse `blueprint.json` (D5).
2. **Refuse before anything is written** when:
   - `appKit` does not match the installed `@indx-workspace/app`;
   - a destination path exists already, or is recorded by another entry (a path collision);
   - an agent slot names an agent the project already defines;
   - an entry `blueprint:<name>` exists already;
   - a migration is destructive (D8).
3. **Render** with `renderTemplateDirectory`, from the verified files extracted into the temporary
   directory. Every part is rendered with no values, so a `{{key}}` in a part is refused rather than
   substituted. Migrations are rendered with exactly one value, `appSchema` (`app_<app name>`, the
   schema `aw generate resource` qualifies tables with), because a migration has to name the
   installing app's schema. Any other `{{key}}` in a migration is refused.
4. **Wire**, as `aw generate` does, and record each change as a one-line edit:
   - each migration is renumbered to the app's next journal index, written as
     `db/migrations/<next>_<tag>.sql`, and appended to the journal (a journal edit);
   - each `resource` part adds its two `app.config.ts` lines from `appConfigLines`, and each
     `recipe` part its two lines from `appConfigRecipeLines`.
5. **Record** a new entry kind, `blueprint:<manifest name>`, in `aw-generated.json`. Its `files`
   map holds each written file's sha256 and its `edits` the wiring edits, as for any entry. A
   blueprint entry also carries, and only a blueprint entry may carry:
   - `source`: a strict `{ package, version, integrity }`, where `version` is exact and `integrity`
     is npm's `sha512-…`;
   - `migrations`: a map from each migration's path in the package to its path in the app.

   The manifest stays `version: 1`. An older `aw` refuses a file with the new kind; `aw` and the
   app kit are pinned in lock-step, so that is accepted.

Without `--yes`, `add` prints the plan (the source and its integrity, each file, each edit, each
slot) and exits 3, so installing third-party code is always reviewed first (D9). With `--yes` it
writes.

### D7 — Update as a proposal: `aw blueprint update <name> [--to <version>] [--yes]`

`update` is plan-first, like `aw deploy`. It fetches the new version (`--to` an exact version;
without it, npm's `latest`, printed as the exact version it resolved), verifies it (D4), checks
`appKit` (D5) and the migrations (D8), and renders it (D6). It then compares three things per file:
the hash recorded at install, the file on disk, and the new version.

| On disk vs recorded | New version        | Plan       | `--yes` does                                         |
| ------------------- | ------------------ | ---------- | ---------------------------------------------------- |
| equal               | changed            | `update`   | writes the new file                                  |
| equal               | removed            | `remove`   | deletes the file                                     |
| (absent before)     | added              | `add`      | writes it; a path collision refuses the whole update |
| differs             | changed or removed | `conflict` | never touches the file (see below)                   |
| differs             | equal to the disk  | (none)     | records the new hash                                 |
| equal               | unchanged          | (none)     | nothing                                              |

- A **conflict** is never overwritten. When the new version changes the file, `--yes` writes it
  beside the file as `<file>.blueprint-<version>`, for the developer to merge. When the new version
  removes the file, the file is kept and its record is dropped: it becomes the developer's own.
- **The hash recorded for a conflicted path** after `--yes` is the new version's hash. A developer
  who takes the sidecar verbatim can then update again cleanly, and a developer who keeps their own
  file sees the same conflict again on the next update (it is still their edit).
- **An existing sidecar refuses the update**, naming it, until the developer merges or deletes it,
  so a second update never buries an unmerged proposal.
- Without `--yes`, `update` prints the per-file plan (`add`, `update`, `remove`, `conflict`) and the
  edits, and exits 3 when there is any change. With `--yes` it applies the non-conflicting changes,
  writes the sidecars, and updates the entry's `files`, `edits`, `migrations` and `source`.
- **`aw blueprint diff <name> [--to <version>]`** prints the same proposal as unified diffs of each
  file, and never writes. It exits 3 when the proposal has any change and 0 when it has none, so
  exit 3 means "changes pending" in every plan-first command, and a CI step can tell whether an
  installed blueprint is behind.

### D8 — Migrations: expand-only, a destructive one refused by name

- A blueprint version may add migrations only in the repository's expand-only discipline: add,
  backfill, switch, then contract in a later release.
- `add` and `update` refuse a migration that holds DDL the repository's `pnpm migrations:lint`
  refuses: `DROP`, `RENAME`, `SET NOT NULL`, `ALTER COLUMN … TYPE`, or a `CHECK` on an existing
  table without `NOT VALID`. The refusal names the migration and the rule. The `-- safe:` exception
  of the repository's own lint does not apply to a blueprint. The SDK holds the same rules as a pure
  function, kept equal to the lint script's by a test.
- A blueprint's migrations come from a package, not from this repository's review, so the guard is
  stricter than the lint in two ways. It reads the SQL as PostgreSQL does: comments are taken out
  by a reader that respects quoted strings, quoted names and dollar quoting, so a `--` or `/*`
  inside a string cannot hide the statement after it, and a comment that is not closed is kept as
  code. And it also refuses, by name, `TRUNCATE`, `DELETE FROM`, a `DO` block, `EXECUTE` (other
  than a trigger's `EXECUTE FUNCTION`), and any mention of `standard_conforming_strings` or
  `backslash_quote`: an expand-only migration adds schema and backfills, and never empties a table,
  deletes rows, runs SQL the guard cannot read, or changes how strings are read. The test keeps
  the lint's rules equal on the statements both read; the stricter rules are the SDK's alone.
- A migration already installed is never rewritten. A new version whose copy of an installed
  migration differs, or that drops one, is refused. A new version may only append.
- A destructive change ships as a separate major version. Its release notes give the contract step,
  which the installing developer writes as their own migration.

### D9 — Trust: a blueprint is third-party code that runs in the app

- A blueprint is layer-3 code. Once written, it runs in the app, with the app's own permissions: a
  route acts as the signed-in person
  ([ADR-0161](0161-an-app-backend-acts-as-the-signed-in-person-by-token-exchange.md)), and a recipe
  writes as the person's agent ([ADR-0164](0164-a-recipe-writes-app-data-as-the-persons-agent.md)). The platform never loads or
  runs a blueprint, and gains no table, route or behaviour for one.
- Agent parts reach the platform only through ordinary agent creation: `aw push` creates an agent
  version ([ADR-0101](0101-the-platform-owns-agent-versions.md)), bounded by the policy ceiling and
  by the approval gates of [ADR-0145](0145-a-run-stops-for-approval-or-handoff-and-continues-in-its-session.md).
  A blueprint cannot widen what a person may do.
- Installing a blueprint is reviewing third-party code, and the documentation says so. That is why
  `add` and `update` show their plan first (D6, D7). Pin exact versions (`--to 1.2.0`, or an exact
  spec to `add`). The recorded integrity makes a re-published version under the same number visible
  as a refusal.

### D10 — Not built

- A marketplace, catalogue or registry service, and any platform table or route for blueprints.
- Data export or import, and seed rows.
- Credential sharing of any kind.
- Automatic updates, and update notifications.
- Remote install from the console or by an agent.
- Renaming or namespacing parts on install (a collision refuses instead).
- Publishing tooling beyond `npm publish` (`aw blueprint pack` and similar).
- Blueprints that depend on other blueprints.

### D11 — Listing and removal

- `aw blueprint list` prints each `blueprint:<name>` entry with its package, exact version and
  integrity, and exits 0.
- Removal is `aw destroy blueprint <name> [--yes]`, through the existing destroy. It already deletes
  only unedited recorded files, refuses a file edited since it was written, and reverts the entry's
  edits: the `app.config.ts` lines, and the journal entries while they are the journal's last. No
  separate `aw blueprint remove` is built.

### D12 — An installed agent part becomes an agent through the project loader

ADR-0133 D3 lets `agents/<name>.ts` and `agents/<name>.agent.md` sit side by side, one definition per
name. ADR-0133 D15 says `create` writes no `.agent.md` and that `agents/<name>.ts` stays the one
definition `create` produces; it does not forbid a project from holding an `.agent.md`.

- **Decided:** the project loader behind `aw push`, `aw dev` and `aw check`
  (`packages/aw/src/project/load.ts`) reads `agents/*.agent.md` beside `agents/*.ts`. It reads each
  with `parseAgentMarkdown` and converts it with `defineAgentFromPortable`. The loader refuses a name
  defined in both forms, and an agent file whose conversion drops a field (ADR-0133 D5). A project
  with only `.agent.md` agents is a valid project.
- **Rejected:** converting the file to `agents/<name>.ts` on install. That would leave two
  definitions of one name, or lose the recorded file an update compares with.
- **Rejected:** printing an import step. The blueprint's agent would not exist until a manual step,
  and the end-to-end install could not be proved.
- ADR-0133's file format is unchanged.

### D13 — The names (ADR-0114)

One word, `blueprint`, is used everywhere:

- the SDK functions in `@indx-workspace/sdk/project` (`parseBlueprintManifest`,
  `readBlueprintArchive`, `planBlueprintUpdate`, and the like);
- the `aw blueprint add|list|diff|update` commands, and `aw destroy blueprint`;
- the `blueprint.json` file and the `indx-workspace-blueprint` keyword;
- the `blueprint:<name>` manifest kind.

There is no route, no `operationId`, no platform table and no UI, so ADR-0114 S1's route-to-SDK
equivalence has nothing to pair. The commands that write follow S2: show first, then `--yes`.

## Consequences

- A team can share a resource with its pages, recipes, agents, skills, tests and migrations, as one
  versioned npm package. The developer receiving it sees every change as a plan or a diff, and no
  edited file is ever overwritten.
- The generated-file manifest gains one kind, `blueprint`, and two fields only that kind may carry.
  Old tools refuse the new file, which the lock-step pin of `aw` and the app kit makes safe.
- The project loader learns `.agent.md`, which also lets an `aw platforms import`ed agent be pushed
  without a hand-written TypeScript file.
- `aw` gains one external process, `npm pack`. A developer without `npm` on the `PATH` gets a
  refusal that names it. Node ships `npm`, and a pnpm project still has it.
- The SDK keeps a copy of the expand-only migration rules, held equal to the lint script by a test.
- The platform is unchanged.

## Proof

Issue #1533 proves these with focused tests; the SDK's pure parts are unit-tested and `aw`'s
commands are tested against a fixture blueprint tarball:

- The plans of `aw blueprint add`, `list`, `diff` and `update`, with and without `--yes`, including
  exit 3 for a plan with changes and exit 0 for none.
- Conflict handling: an edited file stays byte-identical, its `<file>.blueprint-<version>` sidecar
  is written, the recorded hash is the new version's, and an existing sidecar refuses the next
  update.
- An `appKit` mismatch, and a path collision, each refused before anything is written.
- A destructive migration refused by name, and an installed migration changed in a new version
  refused.
- Path traversal (`..`, an absolute path, a symbolic or hard link, a file outside the listed parts)
  refused, and an integrity mismatch refused before the tarball is read.
- A `{{key}}` placeholder in a part refused; `{{appSchema}}` in a migration rendered.
- The loader reading an installed `agents/<name>.agent.md`, and refusing a name defined twice.
- In the apps end-to-end lane, a fixture blueprint installed into `examples/minimal`: the app
  builds, its migrations apply, and `aw destroy blueprint` removes it again.

## Related decisions

- [ADR-0094](0094-agent-workspace-deploy-wraps-compose-helm-and-terraform-plan-first.md) — plan
  first, and exit 3 for a plan with changes.
- [ADR-0101](0101-the-platform-owns-agent-versions.md) — agent parts become ordinary agent
  versions; also cites the 2026-10-04 design review as "the blueprint" (D1).
- [ADR-0103](0103-one-project-file-holds-every-environment.md),
  [ADR-0104](0104-a-team-is-a-resource.md),
  [ADR-0108](0108-the-frontend-is-a-four-rung-ladder-and-a-configuration-agent-edits-it.md) — cite
  the same design review (D1).
- [ADR-0114](0114-the-sdk-and-the-cli-give-each-operation-one-name.md) — one name, and show first
  then `--yes` (D13).
- [ADR-0133](0133-one-portable-agent-definition-exports-to-many-agent-platforms.md) — D3, the
  `.agent.md` interchange file agent parts travel as; D4, secrets are references only; D5 and D15
  (D12).
- [ADR-0145](0145-a-run-stops-for-approval-or-handoff-and-continues-in-its-session.md) — the
  approval gates a blueprint's agents run under (D9).
