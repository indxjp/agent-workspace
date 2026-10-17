# W1-CP-05 — The five input rules spec §17 and the `agents` table do not state

Status: accepted
Date: 2026-09-03
Decided by: W1-CP-05 (Control Plane)
Scope: `apps/web/server/agents/contract.ts` and `apps/web/server/agents/http.ts`; binding on the
§17 agent-creation UI

## Context

The `agents` table types `name`, `instructions` and `model` as unbounded `text` and constrains only
`length(btrim(name)) > 0` plus the `(workspace_id, name)` unique index. Spec §17 shows the five-step
create flow as a screen sketch and states no field rules at all. Four questions therefore have no
answer in either place, and a route handler cannot avoid answering all four.

A fifth was added in verification round 1. Decisions 1–4 are rules about the *row*; nothing here
was a rule about the *request*, and this record's own reasoning had claimed one. Decision 5 supplies
it.

ADR-0004 forbids asking the Owner. This record takes the smallest reading of each and says what it
costs.

## Decision

**1 — Three length bounds, chosen here, not transcribed.**

```text
name            200 characters   (measured after trimming)
instructions    100 000 characters
model           200 characters   (measured after trimming)
```

The reasoning is that a `name` is a label in §19.5's agent picker before
it is data, so a value that cannot be rendered is not a value worth storing. 100 000 characters for
`instructions` is roughly 25k tokens of system prompt, which is far above any plausible §17 Step 1
and far below a denial-of-service. The lengths are UTF-16 code units, which is what
`String.prototype.length` returns: a bound on storage, not on grapheme count.

**2 — `name` is trimmed and stored trimmed; `instructions` is not trimmed.**

The unique index is on the stored bytes, so without trimming `"Support"` and `"Support "` are two
rows that render identically in the picker and the index means less than it looks like it means.
`instructions` is prose fed to a model, where leading whitespace can be deliberate, so it is stored
as sent.

**3 — No cross-field rule between `model` and `modelConnectionId`.**

Both are independently nullable, and `{model: "claude-sonnet-4-5", modelConnectionId: null}` is
accepted. The table permits it, §17 Step 2 presents the two as one user-facing choice without saying
which combinations are legal, and inventing a rule at the API layer that the database does not hold
would put the constraint in the one place a direct `INSERT` bypasses.

**4 — `PATCH` with no recognised field is `400`, not a `200` no-op.**

A body that changes nothing is almost always a client bug — a misspelled field name, a serialiser
that dropped everything — and answering `200` with the unchanged agent reports it as a successful
update. Unknown top-level fields are rejected for the same reason, mirroring the `.strict()` on
core's `AgentPermissions`. Separately, a key present with the value `undefined` is rejected by name
rather than treated as absent: "the client sent a field it could not represent" and "the client sent
no field" are different bugs and only one of them is harmless.

**5 — The request body is bounded in bytes, while it streams, and separately from the fields.**

A field-length bound protects the row. It does not protect the process, because it cannot run until
the body has been read and parsed — and `request.text()` materialises the whole body first. The
first version of this record argued the three lengths above as protection against a
"memory-amplification vector" and against accepting "a 40 MB agent name from an
unauthenticated-until-W1-CP-06 route". Neither was true of what was implemented: a 40 MB body was
fully in memory and fully `JSON.parse`d before the 200-character `name` bound looked at it. The
argument was right and the implementation did not deliver it.

So `http.ts` exports `MAX_REQUEST_BODY_BYTES` and reads the body through a reader that stops at it,
answering `413 request_body_too_large`. The number is **derived, not chosen** — unlike the three
above:

```text
MAX_REQUEST_BODY_BYTES = AGENT_INSTRUCTIONS_MAX_LENGTH x 6   (worst-case "\uXXXX" per code unit)
                       + 64 KiB                              (everything that is not instructions)
```

so it is by construction larger than any body the contract in `contract.ts` can legally accept —
`http.test.ts` asserts that by building the largest such body and requiring a `200`-path answer —
and it moves on its own if the `instructions` bound moves.

`Content-Length` is consulted first, but only as a shortcut. It is absent on a chunked or
stream-bodied request and it is caller-supplied in any case, so a bound that trusted it would be
deciding on the absence of a negative (ADR-0015). The running byte count during the read is the
check that holds, and `http.test.ts` exercises it against a `Request` built from an unbounded
`ReadableStream` that declares no `Content-Length`.

## Alternatives considered

* **No bounds at all, matching the table exactly.** Rejected: the table is reached only through this
  API, and "the database allows it" is not a reason to store a 40 MB agent name. Note that this
  argument is about the row; the request is Decision 5's problem and needed its own mechanism.
* **A body bound expressed as a round number (1 MiB).** Rejected: it would be a fourth invented
  constant, and it could silently become smaller than a legal body if the `instructions` bound
  ever rose. Deriving it from `AGENT_INSTRUCTIONS_MAX_LENGTH` makes that impossible.
* **Rejecting on `Content-Length` alone.** Rejected: see Decision 5. The header is absent on a
  stream body and is written by the caller.
* **Bounds enforced as `CHECK` constraints in the schema instead.** This is the better place for
  them and it is not available: `packages/core/src/db/**` belongs to W1-DB-01. Recorded here as the
  known-better option so that whoever revisits the schema can move them and delete these three
  constants.
* **Trim `instructions` too, for symmetry.** Rejected: symmetry is not a reason to modify a prompt.
* **Require `modelConnectionId` whenever `model` is set.** Rejected under the smallest-reading rule;
  it is a plausible product rule that the specification does not state.
* **Accept an empty `PATCH` as a no-op.** Rejected: see Decision 4. It is also the shape ADR-0015
  warns about — a request that did nothing reported as a request that succeeded.

## Consequences

* **Three numbers in this repository are not derived from anything.** They are in one file, named as
  exported constants, and asserted at their boundaries by `contract.test.ts`, so changing them is a
  one-line edit with test coverage on both sides of the limit. They are still inventions and are
  declared as such on this task's PR.
* **The field bounds are enforced only on this path.** A direct `INSERT`, a seed, or a future
  importer can write a 40 MB name. Until they become `CHECK` constraints this is an API-layer
  promise, not a database guarantee, and nobody should read it as one.
* **The byte bound is a bound on what this handler reads, and nothing further out.** A reverse
  proxy, the Next.js server itself, or a platform edge may buffer a larger body before this code
  runs. Decision 5 stops the handler holding one; it is not a claim about the whole ingress path,
  and a deployment that cares should set a body limit at the proxy too.
* **A UI that sends a `PATCH` on every keystroke will get `400`s** for the empty ones. That is the
  intended pressure: the UI should not send them.
* **If §17 later states a cross-field rule for Step 2**, Decision 3 is what has to change, and it
  changes in `contract.ts` and in the schema together — not in one of them.
