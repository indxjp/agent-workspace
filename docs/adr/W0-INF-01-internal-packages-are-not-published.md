# 0004 · Internal packages are not published, and say so consistently

- **Status:** Accepted
- **Date:** 2026-09-03
- **Deciders:** Owner
- **Context task:** W0-INF-01

## Context

Every workspace member is `"private": true`. The four library packages nevertheless
carried a complete publishing surface — `main`, `types`, `exports` **and**
`files: ["dist"]` — while their tsconfigs emitted `declarationMap` and `sourceMap`
pointing into a `src` directory that `files` would never have shipped. Read together,
the metadata described a package that is published and a package that is not.

`apps/runner` diverged again in the other direction: it declared `main` but no `types`
and no `exports`, so anything that imported `@agent-workspace/runner` would have
resolved it with no types at all.

These files are templates. The plan (§8.5) marks this class of task as one whose pattern
"is copied a dozen times", so an incoherent template is copied incoherently.

## Decision

Nothing in this workspace is published to a registry. The metadata is trimmed to what
in-workspace resolution actually needs:

- **Library packages** (`packages/*`) keep `main`, `types` and `exports` — these are how
  a sibling member resolves the package and its types, published or not — and **drop
  `files`**, which affects only `npm pack` and `npm publish` and is therefore dead
  metadata on a private package. `declarationMap` and `sourceMap` stay: pointing at `src`
  is exactly right when the consumer is another member of the same working tree.
- **Apps** (`apps/*`) are run, not imported. `apps/runner` **drops `main`**; its entry
  point is its `start` script (`node dist/index.js`). It declares no import surface
  because it is not meant to have one.

If a package is ever published, that is a new decision and a new ADR, and it reinstates
`files` at that time.

## Consequences

- The metadata now states one thing. A reader can tell from `package.json` alone whether
  a member is meant to be imported.
- Removing `files` cannot break a private package — no code path reads it — and removing
  `main` from `apps/runner` makes an accidental `import '@agent-workspace/runner'` fail
  loudly instead of resolving to an untyped module.
- **The cost:** if a package is published later, `files` has to come back, and forgetting
  it means publishing the whole directory. The ADR that authorises publishing is the
  place that has to remember.
