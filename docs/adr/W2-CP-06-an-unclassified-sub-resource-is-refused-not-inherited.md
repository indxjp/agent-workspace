# W2-CP-06 — an unclassified sub-resource is refused, not given its parent's grant

Status: accepted
Date: 2026-09-05
Scope: `apps/web/server/rbac/decide.ts`, `apps/web/server/rbac/permissions.ts`; §34's `/api/<resource>/:id/<sub>` shape
Task: W2-CP-06 · Spec: §21, §34

## Context

`decide` parses a path against §34's shape rather than looking it up in a table of route patterns,
and the ADR for the permission split records why. Round 1's parser produced a `(resource, sub)`
pair but only ever *used* the first half: `parseResource` classified segment 2 against §21's table,
and the sub segment was read for one purpose only — telling `run` from `write` on a `POST` to
`…/runs` or `…/messages`. There was no branch in which a sub segment could fail.

The consequence is that a capability shipped as `/api/<classified>/:id/<anything>` inherited the
parent resource's grants, with no edit to `permissions.ts` and no failure from any gate.
Verification registered the route the way any Wave-2 task would — a route file, a declaration with
a mandate on a section that really exists — and both gates passed at 59 of 59 while:

```text
owner    GET /api/agents/:id/secrets -> allow
admin    GET /api/agents/:id/secrets -> allow
builder  GET /api/agents/:id/secrets -> allow
viewer   GET /api/agents/:id/secrets -> allow
--- compare with the top-level secrets resource ---
owner    GET /api/secrets            -> allow
admin    GET /api/secrets            -> deny
builder  GET /api/secrets            -> deny
viewer   GET /api/secrets            -> deny
```

A Viewer was granted a route the same capability at `/api/secrets` denies to everyone but the
Owner. `decide.ts`'s own header asserted the opposite in two separate sentences — that the path is
parsed *"into `(resource, sub-resource)` … and the pair is looked up in §21's split"*, and that
*"adding a route to an unclassified resource cannot be done silently"*. Both were false for the sub
position (ADR-0016).

This is ADR-0015 inverted: a classifier with no rejecting `else`.

## Decision 1 — `SUB_RESOURCES` is the `else`

`permissions.ts` now carries `SUB_RESOURCES: Readonly<Record<Resource, readonly string[]>>` — total
over `Resource` by construction, so a new resource with no entry is a compile error, and the empty
list is the answer that refuses every sub-resource under it. `parseSub(resource, segment)` is
positive in the same shape as `parseResource`: the segment has to *be* one of the pairs the table
classifies. `decide`'s `parsePath` refuses when it is not, and the message names the file to edit.

Three pairs are classified, each because §34 prints the route and §21 gives a reading for it:

| pair | §34 prints | the reading |
| --- | --- | --- |
| `agents` / `runs` | `POST /api/agents/:id/runs` | starting a run is §21's `run` verb on `agents` — *"Create/edit/**run** agents"* |
| `runs` / `events` | `GET /api/runs/:id/events` | §21 gives events no capability of their own; they are the run's contents, so reading them is reading the run |
| `sessions` / `messages` | `POST /api/sessions/:id/messages` | sending a message spends money and executes an agent, so `parseOperation` reads it as `run` on `sessions` |

## Decision 2 — a classified sub-resource keeps the parent's grants; it is not re-resourced

The alternative was to look the sub segment up in `RESOURCES` as though it were a resource of its
own. That is wrong for the case §34 actually prints: `POST /api/agents/:id/runs` is *running an
agent*, and §21 grants running under Builder's *"Create/edit/run agents"*, whereas the `runs` row
of the table is about `GET /api/runs/:id`, a different capability. Re-resourcing would have denied
a Builder the run of its own agent.

So the classification decides only that a human has thought about the segment. The grants stay the
parent's, and the reason each pair may have them is the comment beside it.

## What this decision does not give you

* **It is not a claim of completeness.** `SUB_RESOURCES` classifies what §34 prints today. A wave
  that ships a new sub-resource must add it, and until it does its route is refused — which is the
  point, and which is what ADR-0031 asks for: say where the static check ends, and make refusal the
  `else`.
* **It says nothing about deeper paths.** `/api/<resource>/:id/<sub>/…` was already refused as
  deeper than §34's shape, and still is.
* **It does not police the sub segment's *shape*.** A classified pair is a literal string match; an
  unclassified one refuses. There is no pattern, deliberately, because a pattern is the thing six
  spellings walk past (ADR-0030).
