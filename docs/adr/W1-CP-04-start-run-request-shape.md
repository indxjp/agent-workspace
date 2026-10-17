# W1-CP-04 — The shape of `POST /api/agents/:id/runs`, where §34 gives only the path

Status: accepted
Date: 2026-09-03
Decided by: W1-CP-04 (Control Plane)
Scope: `apps/web/server/runs/api.ts`, `apps/web/app/api/agents/[id]/runs/**`; binding on
W1-UI-02 (the home composer) and W1-UI-03 (the run view)

## D1 amendment

The current start body also accepts the paired `modelConnectionId` and `model` override. The
100,000-character prompt limit is measured in JavaScript UTF-16 code units (`length`), not Unicode
scalar values. Unknown keys remain rejected.

## Context

Spec §34 lists `POST /api/agents/:id/runs` and nothing else about it: no request body, no response
body, no status code. §19.5 rule 2 says a message from the home screen is "an ordinary run of the
selected agent", and rule 4 says switching agent mid-conversation starts a new session. ADR-0004
says choose the smallest reading and record it.

Four things had to be decided.

## Decision

**1. The request body is `{ prompt: string, sessionId?: string | null }` and nothing else.** An
unknown key is **rejected**, not ignored — the reason `packages/core/src/schemas.ts` already gives
for `.strict()`: a setting the server does not know how to honour, accepted silently, is a request
the caller believes was obeyed. Model, tools, files and connectors are deliberately absent: §19.5
rule 2 makes the run use the agent's configuration, and a per-request override here would be the
first crack in that rule.

**2. `sessionId` omitted or `null` means "start a session"; a UUID means "continue that one".** A
session the agent cannot run is `409`, never a silent new session — §19.5 rule 4 requires the fork
to be *said*, and a route that quietly forks makes it impossible for the UI to say it.

**3. `prompt` is capped at 100 000 characters.** The specification sets no limit. This is the
smallest reading that still works: far above any hand-typed message or pasted document, far below
anything that lets one request pin a control-plane process. It is a constant with a name
(`MAX_PROMPT_CHARS`) so that raising it is a visible edit rather than a discovered behaviour.

**4. The response is `202` with `{ run, events }` and a `Location` header pointing at the stream.**
Not `201`: the run is accepted and queued, and what the caller wants next is the event stream, whose
URL is returned rather than constructed by the client. `run` is the same JSON shape
`GET /api/runs/:id` returns, so the UI has one renderer. Timestamps are ISO 8601 strings and no
`bigint` ever appears in a response body.

**5. A run in another workspace is `404`, not `403`.** Spec §25's isolation is not satisfied by a
status code that confirms the row exists to a caller who is not allowed to know that. The same rule
applies to `GET /api/runs/:id` and `GET /api/runs/:id/events`.

## Alternatives considered

* **Accept per-run overrides (model, tools).** Rejected: §19.5 rule 2, and it would let the chat
  screen grant capability the agent does not have — explicitly forbidden by the same rule.
* **`201 Created` with the run body.** Defensible, rejected: nothing is created *and finished*, and
  202 says "accepted, watch this" which is exactly what the endpoint means.
* **Return the first events inline to save a round trip.** Rejected: it makes the response a second,
  partial implementation of the stream, and R-13's whole point is that the transcript is read from
  the log by id.
* **No prompt cap.** Rejected: an unbounded body on an endpoint that then holds it in memory is a
  denial-of-service with extra steps.
* **Ignore unknown body fields, as most JSON APIs do.** Rejected under ADR-0015: silently dropping a
  caller's instruction is the permissive fall-through this programme keeps finding.

## Consequences

* W1-UI-02's composer sends `{ prompt }` and, for a continuing conversation, `{ prompt, sessionId }`.
  It must handle `409` by starting a new session and saying so in one line (§19.5 rule 4).
* A future need for a per-run override — a "run with a different model" affordance — is a spec
  question, not an implementation one, and will surface as a `400 unknown field` rather than as
  silently ignored input.
* `MAX_PROMPT_CHARS` is enforced on characters, not bytes. A prompt of 100 000 astral-plane
  characters is ~400 KB. That is the intended order of magnitude; if a byte cap is ever needed it
  belongs at the HTTP layer, not here.
