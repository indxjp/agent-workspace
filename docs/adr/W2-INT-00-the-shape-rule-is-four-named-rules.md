# ADR-W2-INT-00 — ADR-0026's shape rule is four named rules, and a path outside `/api/` is decided by §34 rather than by shape

Status: accepted
Date: 2026-09-04
Decided by: W2-INT-00 (implementer)
Scope: `tests/route-inventory.test.ts` (`routeShape`, `mandateFaults`); every Wave 2 route declaration

## Context

[ADR-0026](0026-section-34-is-a-shape-rule-and-an-extra-route-cites-its-mandate.md) decision 3 says:

> A route must be `/api/<resource>` or `/api/<resource>/:id[/<sub>]`, resource-plural, no verb
> segments. `POST /api/files/:id/rename` is admissible under §16; `POST /api/renameFile` is not, and
> the gate says which rule it broke.

"Says which rule it broke" requires the rules to be separately named, and two things in that sentence
are not mechanical as written.

**"No verb segments" cannot mean every segment.** The ADR's own worked example admits
`POST /api/files/:id/rename`, whose last segment is a verb. So the prohibition is about the
*resource* position, not about every position.

**"Resource-plural" needs a decidable test.** Every resource §34 prints ends in `s` — `agents`,
`runs`, `sessions`, `models`, `model-connections`, `skills`, `connectors`, `files`, `users`,
`runtime-profiles`, `projects`, `shares` — and so does every resource Wave 2 adds: `secrets`,
`api-keys`, `memberships`.

**Not every route §34 prints is under `/api/`.** §34 prints `GET /p/:token` and
`POST /p/:token/messages`, and says why: *"The public routes live under `/p/` rather than `/api/` so
that 'is this request authenticated?' is answerable by looking at the path prefix alone."* A shape
rule that required `/api/` would fail two routes the specification prints, and W5-CP-06's card ships
exactly those.

A fourth problem is ADR-0015's: a rule expressed only as a blacklist of verbs fails open on the first
verb nobody listed.

## Decision

`routeShape(path, printedInSpec)` returns `{ ok: true }` or `{ ok: false, rule, detail }`, and `rule`
is one of four names that appear verbatim in the failure message.

1. **`outside-api`** — a path not beginning `/api/` is admissible **if and only if spec §34 prints
   it verbatim**. `/p/:token` passes because §34 prints it; `/internal/metrics` fails. A new prefix
   is a specification change, not a route, and this gate is not the place to generalise one.
2. **`shape`** — under `/api/`, the path is `/api/<resource>`, `/api/<resource>/:param`, or
   `/api/<resource>/:param/<sub>`. Literal segments are lower-case kebab-case
   (`[a-z0-9]+(-[a-z0-9]+)*`); the second segment, if present, is a parameter (`:name`); a fourth
   level fails. `POST /api/renameFile` breaks this rule, on the capital `F`.
3. **`plural-resource`** — the resource segment ends in `s`. `POST /api/rename` breaks this rule.
4. **`no-verb`** — the resource segment is not one of an enumerated list of action words. This is an
   **additional** rejection layered on rules 2 and 3, never a substitute: a verb the list has never
   heard of still has to be kebab-case and still has to be plural, so `no-verb` cannot fail open. It
   exists so that `POST /api/exports` fails under the name ADR-0026 gives it rather than under a rule
   about hyphens.

The `<sub>` position is deliberately exempt from rule 4, because ADR-0026 names
`POST /api/files/:id/rename` as admissible. The verb belongs in the method or in a sub-resource of a
named thing; it may not be the thing.

The mandate rules are decided in the same pass and reported the same way: a route §34 does not print
and that carries no mandate; a route §34 *does* print and that carries one; and a mandate whose
`section` is not a heading in `docs/spec.md`. The heading set is parsed from the tracked spec
(`# 34. API Design` and `# 19.5 Home — …` are both matched) and an empty parse throws, because a
citation checked against an empty set is a citation that is never wrong.

## Alternatives considered

* **Apply `no-verb` to every segment.** Rejected: it contradicts ADR-0026's own worked example and
  would refuse `POST /api/files/:id/rename`, which §16 requires.
* **Require an explicit plural list rather than a suffix.** A transcribed list of legal resources is
  the shared mutable resource ADR-0025 has just finished removing, in a smaller costume.
* **Drop `no-verb` as unenforceable and rely on `shape` + `plural-resource`.** Tempting, and nearly
  right: those two catch every spelling anyone has actually proposed. Kept anyway because ADR-0026
  asks the gate to name the rule broken, and "you used a hyphen wrong" is the wrong sentence to show
  someone who wrote `POST /api/exports`.
* **Let a path outside `/api/` pass if it is under `/p/`.** Rejected: that is this gate deciding what
  the public prefix is. §34 decides it, and the gate looks it up.

## Consequences

* W5-CP-06's `/p/:token` routes will pass `outside-api` without an exception being added here,
  because §34 prints them — and will fail the moment somebody invents a third prefix.
* The action-word list will need extending one day. When it does, the extension is a rejection being
  added, never a hole being closed, so forgetting to extend it cannot make a bad route pass rules 2
  and 3.
* Every Wave 2 route-shipping task must read the section it cites, which is ADR-0026's intended
  cost, and must also read this record to know that `/api/<resource>/:id/<sub>` is as deep as the
  URL space goes.
