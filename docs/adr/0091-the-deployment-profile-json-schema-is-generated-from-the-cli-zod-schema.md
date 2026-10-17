# ADR-0091 — The deployment profile's JSON Schema is generated from the Zod schema the CLI validates with

Status: accepted — amends [ADR-0055](0055-the-deployment-profile-is-one-validated-document-the-installer-renders.md) (the validator) and [ADR-0089](0089-the-deployment-profile-is-read-by-a-real-yaml-parser-and-carries-apiversion-and-kind.md) (the generated header)
Date: 2026-10-01
Decided by: the implementer of issue #424 (developer-platform slice 1e, #333)
Scope: `packages/cli/src/profile-schema.ts`, `packages/cli/src/profile.ts`, `packages/schemas`, `packages/cli/schema`, `packages/cli/scripts/generate-profile-schema.mjs`, the root `docs:generate` / `docs:check` scripts, the generated `agent-workspace.yaml`

## Context

`agent-workspace.yaml` was validated by hand-written readers in `profile.ts` (ADR-0055), and
ADR-0089 left the port to Zod to this slice. Editors had nothing to validate or complete the file
from. A JSON Schema written beside the validator would drift from it the first time either changed;
the outcome #424 asks for is a schema that cannot.

## Decision

### One Zod definition, in `packages/cli`

`packages/cli/src/profile-schema.ts` defines the profile in Zod 4.6.5, the version the rest of the
repository pins. `profile.ts` validates with it, and the JSON Schema is converted from it. The
definition is shaped so the conversion loses as little as possible:

- **A union on `cloud`, one branch per cloud.** The rules that depend on the cloud — which managed
  PostgreSQL, object scheme and secret backend it may name — are each branch's own fields, so the
  JSON Schema carries them as structure and an editor completes each cloud's own values.
- **Every accepted value is a pattern or an enum.** Schemes stay case-insensitive by spelling each
  letter as a character class, because JSON Schema patterns carry no flags.
- **The CLI checks in two stages.** The first takes any value for each field and refuses a
  non-block, an unknown root key or a bad envelope; the union reads the fields once it passes. A
  union stops at an unmatched `cloud`, so on its own it would change which refusal is reported.
- **The messages are the old ones.** Each check's error map says why a value was refused in the
  words the hand-written readers used, and `profile.ts` reports the issue the readers would have
  met first (`REFUSAL_ORDER`). `ProfileError`, its paths and the line and column ADR-0089 adds are
  unchanged; the existing tests pass with only line numbers moved by the new header line.

The definition lives in `packages/cli` rather than `packages/contracts`. Contracts are the HTTP
API, versioned by `CONTRACTS_VERSION` and documented by generated reference pages; the profile is
a file the CLI reads. The CLI may depend only on the SDK and contracts
(`cli-depends-only-on-sdk-and-contracts`), so it cannot import the definition from the new
package either.

### What JSON Schema cannot say is listed, and the CLI alone checks it

`CLI_ONLY_PROFILE_CHECKS` names the refinements with no JSON Schema form: a `postgres://` or
`postgresql://` connection string, and the `https://` OIDC issuer, must parse as URLs. An editor
accepts such a value and `agent-workspace validate` refuses it. `profile-schema.test.ts` runs a
corpus of valid and invalid profiles through the CLI and through a draft 2020-12 validator reading
the committed schema, expects the same verdict, and holds each listed check to "the CLI refuses,
the schema accepts", so the list cannot go stale.

`kind` being required once `apiVersion` is set has a JSON Schema form and is written as
`dependentRequired` by the generator. Text fields are trimmed before they are checked, as they
always were; the schema sees the value as written, so an editor flags a quoted value with padding
that the CLI would accept.

### `@agent-workspace/schemas` holds the generated file, and the published CLI ships a copy

`packages/schemas` is a private workspace package, versioned with the others (0.2.1), holding
`agent-workspace.schema.json` (draft 2020-12, `apiVersion: agentworkspace.dev/v1`,
`kind: Deployment`) and nothing else. It is not published: a third party owns `@agent-workspace` on
npm (ADR-0082), and no new npm package is added for one file.

The already-published `@indx-workspace/cli` ships an identical copy,
`packages/cli/schema/agent-workspace.schema.json`: `schema` is in the package's `files`, and
`scripts/release/pack-packages.mjs` accepts `schema/` in the CLI tarball beside `templates/`. A
test packs the CLI (`npm pack --dry-run`) and asserts the tarball carries the file at the path the
`$schema` URL names, with the committed schema's bytes.

### The generator runs in `docs:check`

`packages/cli/scripts/generate-profile-schema.mjs` loads the definition from source (Node 24 type
stripping), converts it with Zod's own `toJSONSchema` (`target: 'draft-2020-12'`, `io: 'output'`),
and writes it with sorted keys, LF and one trailing newline, to both copies. `--write` joins
`pnpm docs:generate` and `--check` joins `pnpm docs:check`, failing when either copy differs, which `pnpm check:fast` already runs: a stale committed
schema fails the existing generated-file gate, with no new workflow. The generator sits inside
`packages/cli`, not under the root `scripts/`, because it imports the CLI's source: from outside
the package that import is one `pnpm package-exports:check` refuses, and exporting the definition
would make it part of the published CLI's API. The package's `files` does not ship `scripts/`.

### The `$schema` URL is the CLI tarball's copy, on unpkg

A generated profile's first line is

```yaml
# yaml-language-server: $schema=https://unpkg.com/@indx-workspace/cli@<CLI version>/schema/agent-workspace.schema.json
```

`PROFILE_SCHEMA_URL` builds it from `CLI_VERSION`. unpkg serves any file of any published npm
version anonymously, and a published version never changes, so the URL never changes underneath a
committed profile: an editor validates against the rules of the CLI that wrote the file. Editors
fetch it; the CLI never does. The repository staying private does not matter, because the file is
read from the npm registry. `@indx-workspace/cli@0.2.1` was published before the copy existed, so
the URL resolves from the first CLI release that ships `schema/`; until then users point their
editor at a local copy of the file.

## Alternatives rejected

- **The Zod definition in `packages/contracts`.** Tracker rule 5 (#331) names it, but it would add a
  public contracts module, its generated reference page and a structure-map entry for a file the
  HTTP API never carries. Moving it later, if workspace files share it, is cheap.
- **The definition in `packages/schemas`, imported by the CLI.** The published CLI would depend on
  an unpublished package, which breaks `npx`, and the dependency rule refuses it.
- **`zod-to-json-schema` or another converter.** A new dependency, when Zod 4's own conversion
  already produces the OpenAPI document (ADR-0080).
- **The file at a `packages-v*` tag on `raw.githubusercontent.com`.** The repository is not public
  (ADR-0082), so an editor's anonymous fetch returns 404, and `packages-v0.2.1` was tagged before
  `packages/schemas` existed.
- **Publishing `packages/schemas` and an unpkg URL for it.** A new npm package for one file, when
  the CLI the profile belongs to is already published at the same version. Under
  `@agent-workspace` the URL would also resolve to whatever the scope's third-party owner publishes.
- **A docs-site URL.** The repository records no hosted docs domain to pin.
- **The `main` branch's raw URL.** It moves ahead of the installed CLI, so an editor would flag
  fields an older CLI accepts, or accept ones it refuses.
- **A separate `schemas:check` script in `check:fast`.** The issue asks for the existing
  generated-file check.

## Consequences

- Every release bump changes the URL, so the four golden profiles in `packages/cli/src/fixtures`
  change with `CLI_VERSION`; `render/artefacts.test.ts` fails until they are updated.
- The URL resolves only for a CLI version published after this change; `0.2.1` predates the copy.
  Until the next release, every generated `$schema` line returns 404 and the editor silently stops
  validating; the CLI is unaffected.
- Editors depend on unpkg being reachable. A profile works without it, and the copy is also in
  `node_modules/@indx-workspace/cli/schema/` wherever the CLI is installed.
- `@indx-workspace/cli` publishes with `zod` as a dependency; it was already installed through
  `@indx-workspace/contracts`.
- Two values the hand-written readers accepted are now refused, by the CLI and the schema alike: a
  quoted `cloud` with padding (`" aws "`), and an OIDC issuer written `https:` without `//`.
- A profile written before this release has no `$schema` line; adding it is optional and changes
  nothing the CLI reads.
- Rolling back is a revert. A profile carrying the comment still parses, because comments are
  ignored.
- Follow-ups: schemas for the `workspace/` files (phase 2); `render` (#422) keeps the line when it
  rewrites a profile.
