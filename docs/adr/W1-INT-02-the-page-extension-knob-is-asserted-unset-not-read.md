# W1-INT-02 — The route gate asserts `pageExtensions` is unset rather than reading it

Status: accepted
Date: 2026-09-03
Decided by: W1-INT-02 (Wave 1 invariants)
Scope: `tests/route-inventory.test.ts`; amends decision 4 of
[W1-CP-05-route-inventory-is-a-three-way-comparison](W1-CP-05-route-inventory-is-a-three-way-comparison.md)

## Context

Next.js serves a file named `route.<ext>` for every `<ext>` in the application's configured
`pageExtensions`. W1-CP-05 established by experiment that this matters — with `pageExtensions` left
alone, `next typegen` emits `route.tsx`, `route.ts`, `route.jsx` and `route.js` and not `route.mjs`;
with `['tsx','ts','mjs']` it emits `route.mjs` and not `route.js` — and decided the set must be
**derived from `apps/web/next.config.ts`**, not written down, because "a `pageExtensions` computed in
the config would defeat a regular expression". It was derived by importing the config dynamically.

`tests/no-sdk-import.test.ts` scans the whole tracked tree for module references and refuses to pass
over one it cannot decide statically. A dynamic import whose argument is a computed expression is
exactly that, and on the Wave 1a union it reported:

```
tests/route-inventory.test.ts: a import() call whose argument is not a plain quoted string,
so this gate cannot tell which module it names
```

That refusal is correct — a dynamic import of a computed path can name anything at run time, which is
the entire premise of the §42 gate — so the two gates are in genuine conflict and one of them has to
change. Every way of keeping the import was tried and none survives: a static `import` of
`apps/web/next.config.ts` fails `tsc` under `verbatimModuleSyntax` (`error TS1295`, because
`apps/web/package.json` declares no `"type": "module"`); a total map from config filename to a
literal-specifier dynamic import runs under Vitest but fails typecheck twice, `TS5097` for the `.ts`
extension and `TS2307` for the two filenames that do not exist.

## Decision

**The knob is asserted to be unset, and the documented default is used.**

`pageExtensions()` still establishes there is exactly one `next.config.*` and still throws if there is
none or more than one. It then reads that file **as text** and throws if the identifier
`pageExtensions` appears in it at all — naming the file, the default set it would otherwise use, and
what the person who set the knob has to do. Only then does it return Next's documented default.

This is [ADR-0015](0015-gates-decide-on-positive-assertions.md)'s shape applied to the gate's own
input: the reader refuses to run against a configuration it cannot interpret, instead of interpreting
it through a construct another gate cannot decide. The property W1-CP-05 wanted — *the day someone
narrows `pageExtensions`, this gate does not silently keep using the old set* — is preserved and is,
if anything, sharper: it fails on the mention rather than trying to compute the new value.

The assertion is repeated as a test of its own, so the returned set is not merely a constant beside a
comment: the test lists the config files present, checks there is exactly one and that it is
`next.config.ts`, and checks its source does not contain the string.

## Alternatives considered

- **Keep the dynamic import and teach the §42 gate to allow it.** Rejected outright. Any rule of the
  form "this particular unresolvable reference is fine" is an allowlist by another name, and the §42
  gate's value is that it has none.
- **Special-case `pathToFileURL(x).href` as "a path, never a package".** Rejected: it is not even
  true — a `file:` URL can point into `node_modules` — so it would be a fail-open rule dressed as a
  positive one.
- **Shell out to `next typegen` and read `.next/types/routes.d.ts`.** This remains the most faithful
  oracle, and W1-CP-05 already named it as the right escalation. Rejected here for the reason it was
  rejected there — it makes a unit test depend on a build step and several seconds — and it is the
  answer the day the assertion below actually fires.
- **Move the config load into a committed helper script the test spawns.** Rejected: the undecidable
  reference moves, it does not go away, and the tracked tree is what the §42 gate scans.

## Consequences

- **Setting `pageExtensions` in `apps/web/next.config.ts` now fails `pnpm test` immediately**, with a
  message that says the gate must be taught the new set and how the current one was established. That
  is a harder stop than the previous behaviour, which would have absorbed the change silently as long
  as the value was a literal array.
- **The default set is now written in this repository rather than read from the application.** The
  guard above is what keeps that honest, and the provenance — `next typegen` against the pinned Next,
  in both directions — stays recorded next to it.
- **A Next plugin that injects `pageExtensions` without the identifier appearing in the config source
  would defeat the text check.** No such plugin is in use; `apps/web/next.config.ts` is five lines
  whose whole body is `const nextConfig: NextConfig = {}` followed by `export default nextConfig`. This is a declared gap on W1-INT-02's PR rather than a
  claim that the check is complete, and the escalation is the `next typegen` oracle above.
