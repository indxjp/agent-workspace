# ADR-W0-INF-03 — An unparseable SPDX string is a policy error going in, and a DENY coming out

Status: accepted
Date: 2026-09-03
Decided by: W0-INF-03, Infra agent
Scope: `scripts/check-licenses.mjs`, `docs/dependency-policy.md`, the `Licence gate` step of `.github/workflows/ci.yml`

## Context

R-16 residual finding N4, routed here by [ADR-0005](0005-r16-residual-findings-resolved-in-implementation.md):

> the socat row gives `GPL-2.0-only WITH <OpenSSL exception>`, which throws in spdx-satisfies
> (``Unexpected `L` at offset 25``). There is no standard SPDX exception id for socat's OpenSSL
> exception … so the angle brackets are honestly signalling a placeholder — and nothing in F6 is fed
> to the CI script, which only ever sees npm-tree licence strings. Harmless, but a reader scanning
> the SPDX column could copy it.

ADR-0005 asks W0-INF-03 to decide "whether that string is a policy error to reject or a case the
script must handle", implement the decision, and pin it with a fixture.

Facts established before deciding, on 2026-09-03:

* There is no socat OpenSSL exception on the SPDX list. `json/exceptions.json` at tag `v3.28.0` of
  `spdx/license-list-data` holds 84 exceptions; the OpenSSL-flavoured ones are
  `cryptsetup-OpenSSL-exception`, `kvirc-openssl-exception`, `openvpn-openssl-exception`,
  `sqlitestudio-OpenSSL-exception`, `vsftpd-openssl-exception` and `x11vnc-openssl-exception`. Six,
  not the four the residual note recorded, and none of them socat's. So the placeholder cannot simply
  be replaced with a real identifier.
* R-16's own classifier routes any string that fails to parse to **REVIEW** (C.1 stage 3), and a
  REVIEW **can be cleared by a recorded exception** (C.1 rule 8). A DENY cannot (C.1 rule 9).
* Therefore, if a package ever declared a string of this shape, the base licence — `GPL-2.0-only`, a
  `denyFamilies` entry — would be laundered into a reviewable verdict by the fact that the *rest* of
  the string did not parse. That is R-16 residual finding N6's failure mode ("a gate that can pass
  what it should stop") arriving by a different door.
* The question is really two questions, and the residual note conflates them: what the *policy lists*
  may contain, and what the gate does with an *inventory* string it cannot parse.

## Decision

Answer both questions, separately.

**Going in, it is a policy error, and the gate refuses to hold one.** No entry of `allow`, `allowDev`
or `review` may be a string that fails to parse as an SPDX expression. `--self-test` asserts this on
every CI run, so a placeholder cannot be pasted into the policy in the first place. R-16 F6's table is
documentation of an OS-level component the npm gate never sees, not a policy input, and its SPDX
column now uses `LicenseRef-socat-GPL-2.0-only-with-OpenSSL-exception` — the SPDX-defined way to name a
licence that is not on the list, and a string that parses.

**Coming out, it is a DENY if a denied identifier is buried in it, and only otherwise a REVIEW.** When
`parseSpdx` throws on an inventory string, the gate scans the raw string for identifier-shaped tokens
(`/[A-Za-z0-9][A-Za-z0-9.+-]*/g`), canonicalises each, and returns DENY naming the offending token if
any is on `denyFamilies` or `denyLiteral`. `GPL-2.0-only WITH <OpenSSL exception>` comes out DENY with
the reason `unparseable SPDX expression containing \`GPL-2.0-only\``. Everything else that fails to
parse still comes out REVIEW.

The salvage scan can only ever move a verdict from REVIEW to DENY. It is unreachable from the ALLOW
path, because ALLOW requires a successful parse. `--self-test` pins that as a property, not just as
individual cases.

## Alternatives considered

* **Treat it purely as a policy error and change nothing in the gate.** This is the narrow reading of
  the finding, and it is what "nothing in F6 is fed to the CI script" invites. Rejected: it leaves the
  gate with a laundering path that costs eleven lines to close. A `GPL-2.0-only WITH <anything>` in an
  npm `license` field is not hypothetical — dual-licensed and exception-carrying C libraries reach npm
  through native bindings, and npm has never validated the field.
* **Make the parser lenient — accept `<…>` as an opaque exception token.** Rejected: it would make
  `GPL-2.0-only WITH <OpenSSL exception>` a *valid* expression, at which point the policy could
  contain one, and a reader could not tell a real exception identifier from a placeholder. Leniency in
  the parser is how a gate stops meaning anything.
* **Deny every unparseable string.** Simple, and strictly safer. Rejected because it denies
  `SEE LICENSE IN README.md`, which is `@anthropic-ai/claude-agent-sdk` — the package the product
  exists to run (spec §28). A DENY cannot be cleared by an exception, so this would make the gate
  unusable on day one and it would be weakened within the week. R-16's REVIEW-with-a-recorded-exception
  is the right treatment for a licence a human has actually read; the salvage scan is what stops that
  treatment being extended to GPL by accident.
* **Match on a substring of `GPL`.** Rejected explicitly by R-16 F5: a substring matcher fails
  `node-forge`'s `(BSD-3-Clause OR GPL-2.0)`, which is a licence we accept on its BSD disjunct. The
  salvage scan tokenises and canonicalises rather than searching for text, and it runs only after a
  parse failure — `(BSD-3-Clause OR GPL-2.0)` parses, so it never reaches the scan.

## Consequences

* A string the gate cannot parse now has two possible verdicts rather than one, so a reader of the
  output must read the `WHY` column. The column always names the buried identifier for a salvaged
  DENY, and always quotes the parse error.
* The salvage scan is a heuristic over a string that is, by definition, not understood. It can be
  wrong in one direction only: it can deny something a human would have reviewed — for example a free
  text licence field that merely mentions GPL in passing. That cost is deliberate, and the escape is a
  policy change with an ADR, never an exception.
* The tokeniser accepts `+` inside a salvage token but the SPDX parser treats `+` as an operator. The
  two must stay in step: if the parser ever accepts a new identifier shape, the salvage regex has to
  admit it too, or a newly parseable string could stop being scanned. `--self-test` covers the current
  shapes; it cannot cover shapes nobody has written yet.
* If SPDX ever publishes a socat OpenSSL exception identifier, the `LicenseRef-` in R-16 F6 should be
  replaced with it. That is a note edit, not a policy change: socat is an A.3 `PATH` prerequisite on
  the user's own machine and must never be baked into a published image regardless (R-16 F6).
