# ADR-0054 — Developer documentation is a Mintlify site whose reference pages are generated from the contracts and the SDK

Status: accepted
Date: 2026-09-21
Decided by: the Owner
Scope: `docs/sdk/site/`, `scripts/docs/`, the `docs:generate` / `docs:check` scripts and the CI step that runs the check

## Context

`packages/contracts`, `packages/sdk` and `packages/aw` landed on `main` in #229 with a README
each and the four design documents under `docs/sdk/`. Those are written for the people who built
the SDK. A developer who has never opened this repository has no page that takes them from
"install" to "first run" and no place where every route, type, problem code and CLI flag is
listed. The design documents also describe a target state with ✅/⬜ rows, which a consumer must
not have to decode.

Reference documentation written by hand drifts. This repository already learned that lesson with
the ADR index (ADR W0-DOC-01, `docs/adr/regenerate-index.sh`): a table nobody derives is a table
that is wrong three times before someone builds the derivation. The same rule has to apply to a
list of client methods and response fields, or the docs will describe the SDK of the week they
were written.

## Decision

1. **The developer documentation is a Mintlify site at `docs/sdk/site/`** — `docs.json` and MDX
   pages, previewed locally with `npx mint dev` and checked with `npx mint broken-links`. The
   four design documents stay where they are; the site links to them and to the ADRs rather than
   restating them. Mintlify is chosen because it renders MDX from the repository with no build
   artefact to commit, has first-class components for parameter tables and code groups, and is
   what the projects this documentation is measured against (Stripe, Vercel, Anthropic) ship.
2. **Reference pages are generated, never written.** `scripts/docs/generate-sdk-reference.mjs`
   reads `packages/contracts/src/*.ts`, `packages/sdk/src/**/*.ts` and
   `packages/aw/src/commands/*.ts` through the TypeScript compiler API and emits
   `docs/sdk/site/reference/**`. Signatures, parameter types, TSDoc and the CLI command tree come
   from the source; the pages carry a "generated — do not edit" banner. Hand-written guides live
   outside `reference/` and link into it.
3. **Staleness is a CI failure.** `pnpm docs:check` regenerates in memory and fails when the
   committed pages differ. It is part of `pnpm check:fast` and runs as a step in the `fast-checks`
   job of `ci.yml`, so a change to a contract, a client method or a CLI command that is not
   accompanied by a regeneration cannot merge. The gate is the mechanism; there is no expectation
   that anyone remembers.
4. **The site documents what exists.** A method the SDK has but the control plane refuses to an
   API-key principal, or a command `aw` deliberately lacks, is documented as such with its
   reason and the server change it waits on, never as a stub. The site does not describe a
   published npm package until one exists (ADR W0-INF-01, ADR-0052 §5).

## Consequences

- `docs/sdk/site/reference/**` appears in every pull request that changes a contract, an SDK
  client or a CLI command; reviewers read it as they read a lockfile — for the diff, not for the
  prose.
- `scripts/docs/` is a lint and typecheck target like every other script; the generator is
  deterministic (sorted exports, no timestamps) so `docs:check` cannot flake.
- Hosting (a Mintlify deployment connected to this repository) is a separate, owner-controlled
  step, like publishing the packages. Until then the site is previewed locally.
- MDX is stricter than Markdown: `<` and `{` in prose are syntax. The generator escapes them and
  every hand-written page is rendered by `mint dev` before it merges.

## Alternatives considered

- **TypeDoc / API Extractor.** They generate from the types alone and produce a shape that reads
  as a type dump; they know nothing about Zod schemas, the CLI tree or the three error envelopes.
  A purpose-built generator over the compiler API is under a thousand lines and emits pages in the
  site's own vocabulary.
- **Generate an OpenAPI document and use Mintlify's OpenAPI pages.** The control plane has no
  OpenAPI document (ADR-0052 §alternatives). Deriving one from the Zod schemas is possible and may
  come later, but it would document the HTTP surface, not the SDK's methods, streams and errors,
  which is what a consumer calls.
- **Docusaurus / VitePress / Starlight.** Each needs a build pipeline and a theme in the
  repository; Mintlify needs a `docs.json`. The decision can be revisited if hosting on Mintlify
  is refused, because the MDX pages are portable.
- **Keep the package READMEs as the documentation.** They are good, and they stay, but three
  READMEs cannot carry a quickstart, a concept model, cross-cutting client behaviour and a
  complete reference without becoming what `docs/sdk/04-api-specification.md` already is.
