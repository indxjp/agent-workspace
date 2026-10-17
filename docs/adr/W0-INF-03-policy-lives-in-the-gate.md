# ADR-W0-INF-03 — The licence policy lives inside the gate, and the gate has no dependencies

Status: accepted
Date: 2026-09-03
Decided by: W0-INF-03, Infra agent
Scope: `scripts/check-licenses.mjs`, `docs/dependency-policy.md`

## Context

R-16 Appendix C.3 is a verified reference implementation and says "Copy this; do not re-derive it."
It asks for three files and one dependency:

* `licence-policy.json` at the repository root, read as `new URL('../licence-policy.json', import.meta.url)`;
* `licence-exceptions.json` at the repository root;
* `spdx-satisfies@6.0.0` added as a root devDependency — "It is the one dependency this gate needs".

Three facts made that shape impossible or unwise here.

1. **W0-INF-03's file ownership does not include the repository root.** The task owns
   `scripts/check-licenses.mjs`, `docs/dependency-policy.md`, research note R-16,
   `docs/adr/W0-INF-03-*.md`, and the licence step of `.github/workflows/ci.yml`. Creating
   `licence-policy.json` and `licence-exceptions.json` at the root would be an ownership violation
   under plan §2.3, which the CI ownership gate enforces mechanically.
2. **`package.json` and `pnpm-lock.yaml` are not ownable here either.**
   [ADR-0009](0009-pnpm-lock-ownership-exception.md) assigns the lockfile to the wave's *first* task
   and rules that "a later task in the same wave that discovers it needs a new dependency
   **escalates**; it does not edit the lockfile in parallel." W0-INF-03 is the last task in Wave 0
   ([ADR-0007](0007-w0-inf-03-deferred-out-of-the-bootstrap-wave.md)). Verified on the branch:
   `pnpm-lock.yaml` contains no `spdx` entry at all.
3. **R-16 F10 defect 2 is a fact about this exact dependency.** `spdx-satisfies@6.0.0` pulls
   `spdx-exceptions@2.5.0` (`CC-BY-3.0`) and `spdx-ranges@2.1.1` (`(MIT AND CC-BY-3.0)`), and without
   `allowDev` entries granted specifically for them "the gate fails on itself on its first run — the
   classic way a new check gets disabled in week one rather than fixed." Two of `allowDev`'s three
   entries exist only to exempt the checker's own supply chain.

Spec §40 asks, before adding a dependency: "Can this be implemented safely and clearly in
approximately 50 lines of TypeScript?" and names the categories where a mature library is mandatory —
cryptography, JWT verification, OAuth, database clients, container protocols. An SPDX expression
parser is in none of them. The grammar is four productions with one precedence rule, published at
https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/ and quoted in R-16 F8.

## Decision

Ship the gate as a single zero-dependency Node ESM file, exactly as `scripts/check-file-ownership.mjs`
already is, with the policy of C.1 and the exception register of C.2 inlined as exported constants and
a hand-written SPDX expression parser and evaluator in place of `spdx-satisfies`. The prose half of
the policy — the copyleft position, the reviewer and reason behind each exception, how each residual
finding was closed — is `docs/dependency-policy.md`. Neither root JSON file is created, and no
devDependency is added.

## Alternatives considered

* **Escalate to the orchestrator for a lockfile edit,** per ADR-0009's escalation rule. Rejected on
  the merits rather than on the process: the escalation would have been to add a dependency whose own
  dependencies then need two policy exemptions in the gate that is checking them. Declining the
  dependency removes the escalation and two `allowDev` entries at once.
* **Put the two JSON files under `scripts/`,** inside the ownership boundary. This was close to
  chosen. Rejected because it splits one contract across three files that must be edited together —
  add a licence to `review` and forget the exception and the gate fails on the next install — and
  because it makes `--self-test` read the filesystem, which is what stops the ownership checker's
  self-test being hermetic. A reviewer diffing `scripts/check-licenses.mjs` now sees the policy, the
  register and the classifier in one diff.
* **Vendor `spdx-satisfies` into `scripts/`.** Rejected: vendoring a package to dodge a lockfile edit
  is the ownership rule wearing a disguise, and it would put a third party's MIT code in our tree with
  no `NOTICE` entry — a licence-hygiene problem raised by the licence gate.
* **Keep the reference implementation byte-for-byte and defer the divergences.** Rejected: ADR-0005
  requires four of R-16's six residual findings to be closed *in this implementation*, and two of them
  (the licence-aware exception match, and denying an unparseable string that hides a GPL identifier)
  are changes to the classifier itself. The reference implementation could not be shipped unchanged
  whatever was decided about its dependency.

## Consequences

* **We own an SPDX parser.** It is **210** lines of code as of 2026-09-03 — `tokenise`, `parseSpdx`,
  `spdxSpellingRegistry`, `spellCanonically`, `canonicaliseSpdx`, `canonicalLicence`,
  `canonicalString`, `canonicalSet`, `expressionSatisfies`, `expressionDenied` and `salvageDenied`,
  counted excluding comments and blank lines — and it is tested by fixtures rather than by
  reputation. It was 171 across nine functions before the case-canonicalisation change added
  `spdxSpellingRegistry` and `spellCanonically` and renamed `normaliseDeprecatedSpdx` to
  `canonicaliseSpdx`; the count is re-derived here rather than carried forward, because a stale
  number in a consequences list is how this file's siblings have gone wrong four times. That is over spec §40's
  "approximately 50 lines" threshold, so §40 is not what carries this decision; ownership is. R-16 F8 records the semantics it must implement, and every case in F8's table is a
  fixture in `--self-test`. If SPDX v3 expression syntax ever matters, this is ours to update.
* **The parser validates syntax, not membership.** `spdx-satisfies` throws on `Unknown` because it
  checks the identifier against the SPDX list; this parser accepts `Unknown` as a well-formed
  identifier that is on none of the policy lists. Both reach REVIEW, so no verdict in R-16's tables
  changes, but the *route* differs — `Unknown` now reaches the final fallback rather than the
  parse-failure branch. R-16 C.1's stage-3 prose describes the reference script on this point; the
  implementation-status box above C.3 says so.
* **Two things R-16 could not do are now done**, because we control the evaluator: an `AND`
  containing a denied licence is DENY rather than the REVIEW R-16 C.1 stage 5 documents as a gap, and
  an unparseable string hiding a denied identifier is DENY (see
  [the unparseable-SPDX ADR](W0-INF-03-unparseable-spdx-expressions.md)).
* **Editing the policy means editing a script.** That is more intimidating than editing JSON, and a
  contributor may hesitate. Mitigated by putting the policy at the top of the file, above any logic,
  and by `docs/dependency-policy.md` being the document a reviewer is pointed at. It is also honest:
  changing the policy *is* changing the gate.
* **If this is reversed** — a wave that owns the repository root extracts `licence-policy.json` and
  `licence-exceptions.json` — the exported `POLICY` and `EXCEPTIONS` constants are the file contents
  and `evaluateInventory` already takes both as parameters, so the extraction is mechanical. The
  self-test's policy-invariant assertions must move with them, or the invariants stop being checked.
