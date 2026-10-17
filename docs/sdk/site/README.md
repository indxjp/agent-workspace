# Agent Workspace docs site

A [Mintlify](https://mintlify.com) site: `docs.json` plus MDX pages, rendered with no build
artefact to commit. See [ADR-0054](../../adr/0054-developer-documentation-is-a-mintlify-site-generated-from-the-contracts.md)
for why this site exists and how it is generated.

## Preview locally

From this directory:

```sh
npx mint dev
```

This starts a local preview of the site (`docs.json` plus every `.mdx` page) with hot reload.

## Check links

```sh
npx mint broken-links
```

Run this before opening a pull request that touches any page in this site. The style guide for
this documentation set requires no dead links.

**Known defect on Windows:** `mint broken-links` reports every link into `reference/**` (any
page two directory levels deep) as broken although the pages exist and render — a
path-separator defect in the checker, not in the links. On Windows, verify against the rendered
site instead: run `npx mint dev`, then check every `](/path#anchor)` and `href="/path"` in the
MDX against the HTML the dev server serves (page exists; `id="anchor"` present). That rendered
check is what this site's pull requests use for acceptance.

## The `reference/` tree is generated

`reference/**` is **generated, never hand-written**. It is produced by
`scripts/docs/generate-sdk-reference.mjs`, which reads `packages/contracts/src/*.ts`,
`packages/sdk/src/**/*.ts`, and `packages/aw/src/commands/*.ts` through the TypeScript compiler
API and emits the pages under `reference/sdk/`, `reference/contracts/`, and `reference/cli/`.

From the repository root:

```sh
pnpm docs:generate   # regenerate reference/** from the current source
pnpm docs:check       # regenerate in memory and fail if the committed pages differ
```

`pnpm docs:check` is part of `pnpm check:fast` and runs in CI (the `fast-checks` job of
`ci.yml`), so a contract, SDK client, or CLI command change that is not accompanied by a
regeneration cannot merge.

The same two commands also regenerate and check the repository's `llms.txt`
(`scripts/docs/generate-llms-txt.mjs`): the reading index for coding agents, built from a curated
list of repository documents and from this site's `docs.json` navigation with each page's
frontmatter `title` and `description`. Adding a page to `docs.json`, or changing a description,
therefore needs `pnpm docs:generate` before `docs:check` passes.

**Do not hand-edit anything under `reference/`.** Every generated page carries a "generated — do
not edit" banner; hand edits are overwritten the next time `pnpm docs:generate` runs, and
`pnpm docs:check` will flag them as drift in CI regardless. If a reference page is wrong, the fix
belongs in the source it was generated from (a TSDoc comment, a contract, or a CLI command
definition) or in the generator itself, not in the generated `.mdx` file.

## Everything else

Hand-written pages — `getting-started/`, `concepts/`, `building/`, `guides/`, `resources/`,
`cli/`, `index.mdx` — are edited directly and reviewed like prose. Shared content lives under `snippets/` and is
imported into pages with `import X from '/snippets/x.mdx'`; see the existing snippets in that
directory for the pattern before adding a new one.

## Today / Target callouts and the roadmap

The site is ordered from the product to the wire: **Introduction** (`index.mdx`,
`concepts/what-is-agent-workspace.mdx`, `concepts/design-principles.mdx`,
`concepts/use-cases.mdx`) says what the platform is, the three values it gives a developer
(managed agents in your own cloud; build the agent, the rest is one call; switch anything,
embed anywhere) and the eight design principles behind them; **Concepts** documents today's
model, including `concepts/data-plane.mdx` (where state, bytes, secrets and sandboxes live, per
cloud, with the cells verified today) and `concepts/ownership-and-sharing.mdx` (catalog →
assignment → grant, and the role table the server enforces); **Where it is going** holds
`concepts/target-architecture.mdx` (what Agent Workspace is meant to be once finished — the
time budgets, the developer experience, the layout) and `concepts/roadmap.mdx` (every gap
between the two, one `###` heading per item, ids `S-n`, `RF-nnn`, `P-n`, `K-n`, `A-n`);
**Building with Agent Workspace** is the task guides (including `building/http-api.mdx` for a
consumer with no SDK). `concepts/public-surface.mdx` fixes the vocabulary every page uses for
where the reader stands: the four surfaces — Consume, Configure, Extend, Internal. Roadmap ids
`D-n` (data plane) and `N-n` (capabilities the specification does not list yet) are proposed on
the site and become an ADR or a specification entry before work starts; the roadmap's prefix
table says so.

Wherever a page documents behaviour that differs from the target, it says so in a callout of
this exact shape, linking to the roadmap heading:

```mdx
<Note>
  **Today:** …. **Target:** …. Tracked as [S-13](/concepts/roadmap#s-13-agent-policy-on-the-wire).
</Note>
```

Use `<Warning>` instead of `<Note>` only for a security or data-loss gap. Do not write a callout
for a gap that is not on the roadmap page: add the roadmap entry first (with where it is
tracked in the repository), then link to it. When a roadmap item lands, delete its callouts and
its roadmap entry in the same change that regenerates the reference.
