# ADR-0089 — The deployment profile is read by a real YAML parser, and carries `apiVersion` and `kind`

Status: accepted — amends [ADR-0055](0055-the-deployment-profile-is-one-validated-document-the-installer-renders.md) (the document format)
Date: 2026-10-01
Decided by: the implementer of issue #420 (developer-platform slice 1a, #333)
Scope: `packages/cli/src/profile-document.ts`, `packages/cli/src/profile.ts`, `packages/cli/src/validate.ts`, `packages/cli/package.json`, the generated `agent-workspace.yaml`

## Context

ADR-0055 made `agent-workspace.yaml` a closed subset of YAML read by a hand-written reader: a
two-level mapping of string scalars, single quotes only, and every other construct refused by line
number. It named its own exit: replace the reader with a YAML library, keeping `ProfileError` and
the refusal messages.

The developer platform (#333) now needs that exit. Its later slices render, deploy and diagnose
from the profile and from future `workspace/` files, and a JSON Schema for editors (slice 1e)
describes a YAML document, not a dialect of one. An operator who writes `cloud: "gcp"` or a flow
mapping has written valid YAML and should not be told otherwise. The profile also has no version,
so a later change to its shape could not tell an old file from a new one.

## Decision

### The parser is `yaml` (eemeli/yaml) 2.9.1, with the core schema

`packages/cli` takes `yaml@2.9.1` as a runtime dependency, pinned exactly. The evidence:

- **Already in the tree.** It was a development dependency of `packages/cli` (the golden tests
  parse rendered Helm values with it) and is resolved in `pnpm-lock.yaml`, so moving it to
  `dependencies` adds no package to the install.
- **No dependencies of its own**, and ISC-licensed, which `scripts/check-licenses.mjs` allows.
- **Maintained**, with YAML 1.2 as its default and the 1.2 core schema available by name.
- **Keeps source positions.** Every node carries its byte range and the parser feeds a
  `LineCounter`, so a refusal can name a line and a column, and a schema refusal can be traced
  back to the key that caused it.
- **A concrete syntax tree is exposed.** Anchors, aliases, tags and directives are visible as
  tokens with offsets, so they can be refused where they are written rather than after the parser
  has resolved them.

The core schema is used rather than YAML 1.1's: `yes`, `on` and `0777` stay text, and `true`,
`null` and numbers are typed, so the profile schema refuses them as "must be text".

### What is refused, and that every refusal names the line and the column

The parser reads; `profile-document.ts` then refuses anything that could make one file mean two
things:

- **anchors and aliases** — a value written once and read in two places;
- **tags beyond the core schema's own** — every tag other than `!!str`, `!!int`, `!!float`,
  `!!bool`, `!!null`, `!!map` and `!!seq`;
- **directives** — `%TAG`, which would redefine what a tag means, and `%YAML`, which would switch
  the schema;
- **duplicate keys**, which YAML readers resolve differently (`yaml` keeps the last; others keep
  the first or fail);
- **more than one document** in the file;
- **a key that is not text**, such as `1:` or a mapping used as a key;
- **anything the parser reports** as an error or a warning, which includes tabs used as
  indentation and unterminated quotes or flow collections.

Every refusal names the line and the column: `agent-workspace.yaml line N, column M: …`. When a
file has several problems, the earliest one is reported. The profile schema's own refusals
(`ProfileError`) keep their dotted path and gain the position of the deepest key on that path that
exists in the file — the key itself, or for a missing field the block it is missing from. A
profile built in memory (the generator's own) still has no position and keeps the
`agent-workspace.yaml: <path> …` message.

### What is now accepted that the subset refused

Double-quoted scalars, flow collections, block scalars and any consistent indentation width are
valid YAML that the parser reads one way only, so they are accepted when the values they produce
pass the profile schema. A sequence or a third level of nesting is still refused — by the schema
("must be text", "must be a block of fields"), now with its line. Every profile the subset accepted
reads to the same value, with one exception that changes no outcome: `key:  # comment` is now
`null` rather than an empty block, and both are refused by the schema.

### The writer stays canonical

`serializeProfileDocument` keeps writing the two-level form the documentation prints. A value is
written plain only when the parser, under the core schema, reads that plain form back as the same
string; otherwise it is single-quoted, or double-quoted when it holds a control character. Asking
the parser replaces the hand-written list of YAML indicators, so `true`, `null`, `1.0` and `~` can
no longer be written as something other than text.

### `apiVersion: agentworkspace.dev/v1` and `kind: Deployment`

The profile carries both, as its first two keys, and the generator writes them. They describe the
document, not the deployment, so `DeploymentProfile` does not carry them: `parseProfileDocument`
checks and removes them before the schema sees the rest.

- An `apiVersion` other than `agentworkspace.dev/v1`, or a `kind` other than `Deployment`, is
  refused, naming the line.
- A profile with an `apiVersion` must also have a `kind`.
- **Through 0.2.x, a profile with no `apiVersion` is read as v1**, and the `validate` command
  prints a warning on stderr that names the two lines to add. **`@indx-workspace/cli` 0.3.0
  refuses it.**
- A profile with a `kind` but no `apiVersion` is read the same way: the same warning, and the
  `kind` value is still checked, so `kind: Something` is refused. It is not refused as a separate
  case. From 0.3.0 it is refused because its `apiVersion` is missing, by the same rule as a
  profile with neither key.

### The hand-written validator stays

Issue #420 asked to keep "the same Zod validation". The validator in `profile.ts` is hand-written,
not Zod (ADR-0055 deferred Zod). Porting it is not needed to read the file with a real parser, and
it would rewrite every refusal message and path. The port belongs with slice 1e, which generates
the JSON Schema from a Zod source.

## Alternatives rejected

- **Keep the subset reader and add the two keys.** It does not meet the outcome: the profile would
  still not be read by a YAML parser, and the future `workspace/` files would need a second reader.
- **`js-yaml`.** It is widely used, but it stops at the first error, exposes no concrete syntax
  tree to find anchors and tags in, and its default schema adds timestamps, binary and merge keys
  to the core schema. It is also not in the tree.
- **`yaml.parse` alone, letting the library resolve anchors and tags.** The value would be correct
  as YAML and still not be what the operator sees on the line they read. Refusing is cheaper than
  explaining.
- **`yaml.stringify` for the writer.** Its quoting and layout differ from the goldens and the
  documented examples, for no gain in this slice.
- **Add `apiVersion` and `kind` to `DeploymentProfile`.** Every caller of `validateProfile` and
  every fixture object would change for two fields that never vary per deployment.
- **Refuse a profile without `apiVersion` at once.** Every project generated by 0.2.x would fail
  `validate` on upgrade with nothing to gain from the refusal.
- **Refuse a `kind` without `apiVersion` now, before 0.3.0.** It would be a second, narrower grace
  rule for no operator benefit: the missing `apiVersion` already warns, the `kind` value is already
  checked, and 0.3.0 refuses the file anyway.

## Consequences

- A file-backed refusal now reads `agent-workspace.yaml line N, column M: …` instead of
  `agent-workspace.yaml: …`. A script that matches the old prefix needs adjusting.
- `@indx-workspace/cli` publishes with `yaml` as a dependency.
- Rolling back means operators delete the `apiVersion` and `kind` lines, which the old reader
  refuses as unknown keys.
- The grace period for a missing `apiVersion` ends with `@indx-workspace/cli` 0.3.0, which changes
  the warning into a refusal and says so in its changelog. Until a code change names that release,
  the warning `validate` and `doctor` print still says "a later release"; the release is 0.3.0.
- Slice 1e replaces the hand-written validator with a Zod schema and generates the JSON Schema
  from it; this decision's refusals and positions stay as they are.
