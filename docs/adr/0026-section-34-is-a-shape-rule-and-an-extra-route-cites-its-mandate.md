# ADR-0026 — Spec §34 is a shape rule, not the closed set of routes; an extra route must cite the section that mandates it

Status: accepted
Date: 2026-09-04
Decided by: orchestrator
Scope: `tests/route-inventory.test.ts`'s specification assertion; every Wave 2 route

## Context

`tests/route-inventory.test.ts` asserts three things, the third being that no route ships which
spec §34 does not name. In Wave 1 that assertion was free: every route Wave 1 shipped —
`/api/agents`, `/api/agents/:id/runs`, `/api/runs/:id`, `/api/runs/:id/events` — is printed in §34
verbatim.

Wave 2 fails it on contact. §34's list, read out of `docs/spec.md`, contains no route for secrets,
no route for API keys, no route for memberships, and for files and skills only `GET` and `POST` on
the collection. The same specification requires, in other sections:

* **§16** — files must be renamed and deleted, and folders created. Two verbs §34 does not print.
* **§22** — an API key is created, listed, and **revoked**. Revocation is the point of the feature.
* **§23** — secrets are created and referenced. Their API is write-only, which is a statement about
  a route existing and refusing to return a value, not about no route existing.
* **§21** — a membership's role is changed. §34 prints `GET` and `POST /api/users` only.

§34 introduces its list with the word **"Examples:"**, and its actual normative sentences are
*"Expose a very small control-plane API"* and *"Do not invent RPC frameworks if ordinary HTTP is
enough."* Reading the example list as a closed set makes §47's completion criterion — a
non-technical user configures files, skills, MCP, permissions without editing configuration —
unreachable, and it does so on the strength of a word the specification did not use.

Reading it as no constraint at all is worse, and is the failure §34 was written against: *"the way
that instruction is normally lost is one convenience endpoint at a time, each defensible on its
own"* (`tests/route-inventory.test.ts`). Dropping the assertion would delete the only mechanism
this repository has for noticing that.

## Decision

1. **§34's printed list stays authoritative for every route it names.** A route it prints ships at
   that method and that path, or the gate fails. Nothing here relaxes that half.
2. **A route §34 does not print may ship only with a machine-checked mandate.** Its declaration
   entry (per [ADR-0025](0025-the-route-inventory-is-partitioned-by-owner.md)) carries a required
   `mandate` field naming the specification section that requires the capability, and a one-line
   `because` stating which sentence. The gate:
   * **fails** if a non-§34 route has no `mandate` — absence of a justification is not a
     justification ([ADR-0015](0015-gates-decide-on-positive-assertions.md));
   * **fails** if the cited section does not exist in `docs/spec.md`, checked by parsing the
     headings, so a citation cannot be invented;
   * **fails** if a route in §34's own list carries a `mandate`, because that means its author did
     not know it was already named and the two lists have drifted.
3. **The shape rule is enforced, not assumed.** A route must be `/api/<resource>` or
   `/api/<resource>/:id[/<sub>]`, resource-plural, no verb segments. `POST /api/files/:id/rename`
   is admissible under §16; `POST /api/renameFile` is not, and the gate says which rule it broke.
4. **`/api/secrets` returns no secret value.** §23's write-only rule is a property of the handler,
   asserted by W2-CP-02's own test that scans every response body, and it is not satisfied by the
   route being absent.

## Alternatives considered

* **Treat §34 as closed and route everything else through existing paths** — secrets as a field on
  an agent, API-key revocation as a `PATCH /api/users/:id`. Rejected: it makes the URL space lie
  about the resource model to satisfy a list introduced with "Examples", and §36's audit log would
  record the wrong subject.
* **Amend §34 to print every route Wave 2 needs.** The specification is the input to this
  programme and is not edited by it — a rule this repository has held since Wave 0. Where the spec
  is genuinely wrong the plan records it (four such records so far); this is not wrong, it is
  explicitly exemplary.
* **Drop the "no route §34 does not name" assertion.** Rejected: it is the half of the gate that
  catches the failure the section exists to prevent. The half that is easy to keep is the one that
  catches missing routes, and it is not the one that matters.

## Consequences

* Every Wave 2 route-shipping task must read the section it cites. That is the intended cost.
* The gate now parses `docs/spec.md` twice — once for §34's list, once for the heading set. Both
  reads are of the tracked file, so a citation cannot be satisfied by an untracked edit.
* A future wave that finds `mandate` being used to wave routes through should tighten this ADR, not
  remove the field. The field makes the drift visible, which is the whole of what it is for.
