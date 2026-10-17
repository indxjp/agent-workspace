# Dependency and licence policy

This is the prose half of the licence gate. The machine-readable half is the `POLICY` and
`EXCEPTIONS` constants at the top of `scripts/check-licenses.mjs`; the evidence behind every verdict
is research note R-16 (licensing), which resolved the licence of every dependency this plan
introduces by live probe on 2026-09-03.

CI runs three commands in the `Licence gate` step of `.github/workflows/ci.yml`, all blocking:

```
node scripts/check-licenses.mjs --self-test   # the gate's own fixtures; no network, no node_modules
node scripts/check-licenses.mjs               # the --prod tree: what we redistribute
node scripts/check-licenses.mjs --dev         # the --dev tree: build-time only, looser policy
```

The gate exits non-zero on any DENY, and on any REVIEW that has no recorded exception. It has no
dependencies of its own — see [ADR-W0-INF-03 · policy lives in the gate](adr/W0-INF-03-policy-lives-in-the-gate.md).

---

## 1. Before the licence question: may this dependency exist at all?

Spec §40 is the first gate and it is not about licences. Before adding anything, ask: *can this be
implemented safely and clearly in approximately 50 lines of TypeScript?* If yes, write it. The
categories where a mature library is **mandatory** rather than merely permitted are cryptography, JWT
verification, OAuth/OIDC, database clients and container protocols; hand-rolling any of those is a
review failure.

R-16 contradiction 4 records that §40 never mentions licences — "a dependency can be small,
well-maintained, security-critical *and* AGPL" — so the rule needs a second question, which this file
and the CI gate supply: **is its licence on the ALLOW list?** Both questions must be answered yes.

> **Still open, and carried forward from the stub this file replaced.** The stub carried the
> paragraph below, added by a code-review round on `aw/w0-03-governance`. It asked W0-INF-03 to
> settle the question in words, and this file does not — it settles what may be *redistributed*,
> which is a different question from what §28 permits to *exist*. Kept verbatim rather than dropped
> in the restack, because deleting an unanswered question during a conflict resolution is how it
> stops being asked. It is a §28 amendment, not a licence verdict, so it is not the licence gate's
> to close.
>
> > **Known conflict, recorded rather than resolved (code review, 2026-09-03).** The interim rule
> > above is **already violated by the tree it governs, on the day it is written**, and it has no
> > toolchain carve-out. `docs/spec.md` §28 lists Node, TypeScript, pnpm, Next.js, React, Tailwind,
> > shadcn/ui, the Agent SDK, PostgreSQL, Drizzle, S3, Zod, OpenTelemetry, Docker, Kubernetes and
> > Helm. The root `package.json` that W0-INF-01 landed additionally pins `@eslint/js`, `eslint`,
> > `eslint-config-prettier`, `prettier`, `typescript-eslint`, `vitest` and `@types/node` — seven
> > devDependencies, none of them in §28, all of them required by the quality gates §9.1 mandates.
> > Read literally, the rule blocks the linter that CI runs.
> >
> > Two readings are available and this file deliberately picks neither, because picking one **is**
> > the policy decision that W0-INF-03 exists to make: either §28 is a list of *runtime and product*
> > technologies and the toolchain was never in scope, or the rule needs an explicit
> > `devDependencies` carve-out. Whichever W0-INF-03 chooses, it should say so here in words, so
> > that the next task adding a dev tool does not have to guess which reading was intended. Until
> > then, treat the rule as governing **runtime dependencies**, escalate anything else, and do not
> > cite this paragraph as authority for adding one.

The five-service constraint (spec §33) and the §38 non-goals are unaffected by licence and are
rejected on sight regardless of it.

---

## 2. The lists

Identifiers are written below in their registered SPDX spelling, but **matching is
case-insensitive**, as SPDX itself specifies: `mit`, `MIT` and `MiT` are one licence, and so are
`gpl-2.0-with-classpath-exception` and `GPL-2.0-WITH-CLASSPATH-EXCEPTION`. The gate canonicalises
every incoming identifier onto the spelling used here before anything is compared, so the lists
below need only one row per licence. Case-sensitive matching was a laundering door — an upper-cased
denied identifier came out REVIEW, which an exception can clear — and it is closed at the boundary
rather than at each comparison site; see
[the door ADR](adr/W0-INF-03-a-review-verdict-is-a-door-and-every-way-to-reach-it-is-a-lock.md).
Case is the only latitude: `MITTENS` is not `MIT`.

All 30 identifiers the policy uses were checked mechanically against SPDX License List **3.28.0**
(released 2026-02-20, 727 licences) on 2026-09-03: every one is present and none is deprecated.
`--self-test` re-asserts that on every CI run.

### ALLOW — use freely, no record needed

`MIT` · `MIT-0` · `ISC` · `Apache-2.0` · `BSD-2-Clause` · `BSD-3-Clause` · `0BSD` · `Unlicense` ·
`CC0-1.0` · `BlueOak-1.0.0` · `Python-2.0` · `PostgreSQL`

Permissive, notice-only, no copyleft reach into our source or into either published image.

### ALLOW, `--dev` run only

`MPL-2.0` · `CC-BY-3.0` · `CC-BY-4.0`

The dev tree is never redistributed: we ship no devDependency in either image of spec A.2. `MPL-2.0`
reaches us as `lightningcss` via `vitest` → `vite`; it is file-level weak copyleft and would oblige
disclosure only of modified MPL files, of which there are none. R-16 F4 is explicit that prod and dev
must be *separate runs with different policies*, "or the dev tree will produce noise that trains
reviewers to ignore it".

### REVIEW — allowed only with a recorded exception

`MPL-2.0` · `EPL-2.0` · `CDDL-1.0` · `CC-BY-4.0` · `CC-BY-3.0` · `LGPL-2.1-or-later` ·
`LGPL-3.0-or-later` · `Apache-2.0 AND LGPL-3.0-or-later` · `Apache-2.0 AND LGPL-3.0-or-later AND MIT`

Anything that parses as SPDX but is on none of the four lists is also REVIEW, as is anything the
parser cannot read (`Unknown`, `SEE LICENSE IN README.md`, a legacy `BSD*` glob) — with one exception,
in §5 below. Unknown is not the same as safe.

### DENY — never, and not clearable by an exception

**Families**, matched against the canonical form of every licence in the expression so the deprecated
identifiers are caught too (`GPL-3.0`, `GPL-3.0+`, `AGPL-3.0` and `GPL-2.0` all canonicalise onto an
entry here — R-16 F10 defect 1 is a deny list that missed exactly these — and the seven deprecated
`GPL-N.0-with-<something>-exception` spellings are rewritten by stage N into a `WITH` expression whose
base is one of these):
`GPL-2.0-only` · `GPL-2.0-or-later` · `GPL-3.0-only` · `GPL-3.0-or-later` · `AGPL-3.0-only` ·
`AGPL-3.0-or-later`

**Literal strings**, matched exactly, because they either do not parse as SPDX or are
source-available rather than open source:
`SSPL-1.0` · `BUSL-1.1` · `Elastic-2.0` · `CC-BY-NC-4.0` · `CC-BY-SA-4.0` · `UNLICENSED`

`UNLICENSED` is the one string here that is **not** an SPDX identifier — it is npm's convention for a
package with no licence grant at all. That is why it is matched literally and appears nowhere else.

**Package names**, regardless of licence — see §6.

---

## 3. How a licence string is classified

A normalisation pass, then seven stages. The first stage that matches decides.

| # | Stage | Verdict |
| --- | --- | --- |
| N | deprecated single-identifier `WITH` forms are rewritten to their current SPDX spelling | — |
| 0 | package name on `denyByName` (prefix or exact) | DENY |
| 1 | licence string on `denyLiteral` (exact) | DENY |
| 2 | the expression is satisfied by the ALLOW list | ALLOW |
| 3 | the expression does not parse | DENY if a denied identifier is buried in it, else REVIEW |
| 4 | licence string on the REVIEW list (exact) | REVIEW |
| 5 | the expression obliges compliance with a denied licence | DENY |
| 6 | anything else | REVIEW |

Stage N is not cosmetic and it is not derivable, which is why it is a table read off SPDX rather than
a pattern. SPDX deprecated seven single-identifier `WITH` spellings — `GPL-2.0-with-autoconf-exception`,
`-bison-`, `-classpath-`, `-font-`, `-GCC-`, and `GPL-3.0-with-autoconf-exception` and
`-GCC-exception`. Each is **one token**, so it parses as a bare licence identifier rather than as a
`WITH` expression, and stage 5 — which decides a `WITH` on its base — never sees a `WITH` to decide.
All seven classified REVIEW, and a REVIEW is clearable by a recorded exception, so each was a way to
put GPL into the tree and clear it with a two-line register entry. Rewriting them first makes stage 5
see a real `WITH` whose base is `GPL-N.0-only`, and the verdict is DENY, which nothing clears. The
replacement for each is transcribed from that identifier's own `licenseComments` field in
`v3.28.0/json/details/<id>.json`, because the exception half carries its own version and cannot be
derived from the spelling: `GPL-2.0-with-GCC-exception` becomes `GCC-exception-2.0`, but
`GPL-3.0-with-GCC-exception` becomes `GCC-exception-3.1`. A GNU-family identifier with a `-with-` tail
that is on no SPDX list at all is expanded the same way, on its base, so an invented spelling denies
too. Reasoning, and the alternatives rejected:
[ADR-W0-INF-03 · a REVIEW verdict is a door](adr/W0-INF-03-a-review-verdict-is-a-door-and-every-way-to-reach-it-is-a-lock.md).

Which stages actually change a verdict, measured on 2026-09-03 by short-circuiting each one in a copy
of the script and re-running `--self-test`: stage N → 11 failures, stage 1 → 3, stage 2 → 13, stage 3
→ 3, stage 5 → 19, and **stage 4 → 0**. Stage 4 is a documentation stage today, not a verdict stage:
`POLICY.review` holds no entry stage 2 would allow and none stage 5 would deny, so every review entry
falls through to stage 6 and comes out REVIEW regardless. It is kept because it makes the REVIEW list
mean "reviewed and listed" rather than "fell through", and `reviewNeverShadowsDeny` is what keeps that
substitution safe.

Three further properties are worth stating because getting any of them wrong turns the gate into
decoration:

* **ALLOW is checked before DENY.** `node-forge@1.4.0` declares `(BSD-3-Clause OR GPL-2.0)`. Under
  SPDX semantics `OR` is the licensee's choice, so we take BSD-3-Clause and incur no copyleft. A
  deny-first gate rejects it for a licence we never accepted (R-16 F5, F10 defect 1).
* **`OR` and `AND` are evaluated structurally, not by string matching.** An `AND` is denied if
  **either** operand is denied — so `MIT AND GPL-3.0-only` is DENY. An `OR` is denied only if
  **both** are. This closes the gap R-16 C.1 stage 5 documents as a limitation of
  `satisfies(expr, [family])`.
* **A base licence plus an exception is not the base licence.** `Apache-2.0 WITH LLVM-exception` is
  ALLOW only if that whole string is an ALLOW entry, which it is not; it is REVIEW.
  `GPL-2.0-only WITH Classpath-exception-2.0` is DENY, because a `WITH` is decided by its base unless
  the policy names the whole string. If you ever want to review one of those rather than deny it, the
  `reviewNeverShadowsDeny` assertion in `--self-test` is the place that decision gets recorded.

---

## 4. The exception register

Every exception carries five fields, and `--self-test` fails if any is missing: `licence` (the exact
string pnpm reports), `scope` (`prod`, `dev` or `all`), `reviewer`, `reason`, `expires`. An exception
with no expiry is a policy change wearing a disguise. An exception can **never** clear a DENY.

**An expiry the gate cannot read fails closed.** The gate requires `expires` to be a string that
`Date.parse` accepts, and reports the package if it is not. This is stated because it used to be the
opposite: the check was `Date.parse(entry.expires) < now`, `Date.parse` returns `NaN` for a missing,
empty or unrecognised value, `NaN < now` is `false`, and so an exception with no usable expiry skipped
the expired branch and cleared its package **forever**. The five-fields assertion did not cover it,
because that assertion reads only the register in this file — an entry typed `expires: 'soon'`, or a
register supplied by a caller, went straight through. A non-string is refused too: `Date.parse`
coerces its argument, so `expires: 90` parsed as the year 1990 and reported "expired 90" rather than
naming the mistake. Same ADR as stage N above.

The register is in `scripts/check-licenses.mjs`; this is what it holds today.

| Package pattern | Licence matched | Scope | Reviewer | Expires | Why |
| --- | --- | --- | --- | --- | --- |
| `@img/sharp-libvips-*` | `LGPL-3.0-or-later` | prod | Owner (D-01) | 2026-12-02 | Prebuilt libvips, loaded dynamically and unmodified by `sharp`, itself an *optional* dependency of Next.js. Weak copyleft: notice and a source offer, no disclosure of our source. |
| `@img/sharp-win32-*` | `Apache-2.0 AND LGPL-3.0-or-later` | prod | Owner (D-01) | 2026-12-02 | The same libvips, bundled into the platform package rather than split out. Never present in a published Linux image. |
| `@img/sharp-wasm32` | `Apache-2.0 AND LGPL-3.0-or-later AND MIT` | prod | Owner (D-01) | 2026-12-02 | The same libvips compiled to wasm, plus the MIT Emscripten runtime. Resolved only where no native binding exists. |
| `caniuse-lite` | `CC-BY-4.0` | prod | Owner (D-01) | 2026-12-02 | Browser-support data shipped inside Next.js. Attribution-only; satisfied by `NOTICE`. |
| `@anthropic-ai/claude-agent-sdk` | `Unknown` | prod | Owner (D-13) | 2026-12-02 | Proprietary — see §7. Must be installed unmodified from npm at image build time, never vendored or patched. |
| `@anthropic-ai/claude-agent-sdk-*` | `Unknown` | prod | Owner (D-13) | 2026-12-02 | The per-platform compiled `claude` binary the SDK resolves through eight `optionalDependencies`. Same terms. |

The 2026-12-02 expiry is R-16's own re-verification date (probe date + 90 days). The gate fails on an
expired exception by design, so the date enforces itself rather than relying on anyone remembering.

**The `licence` column is compared, not decorative.** An exception clears a package only for the exact
licence string it was granted for. If `caniuse-lite` relicensed from `CC-BY-4.0` to `MPL-2.0`, the
exception would no longer match and the gate would fail with a row saying so. This is R-16 residual
finding N6, closed in §8 below.

---

## 5. The copyleft position, for a self-hostable product

We publish three kinds of artefact: an npm tarball, the two Docker images of spec A.2
(`control-plane`, `runtime`), and the Helm chart of A.5. The position is:

* **No strong copyleft, anywhere in any of them.** GPL and AGPL, in every spelling including the
  deprecated identifiers, are DENY and are not clearable by an exception. R-16 verified that the only
  `GPL` string in the whole npm tree is `node-forge`'s `(BSD-3-Clause OR GPL-2.0)`, which is a
  dual licence we satisfy by taking BSD-3-Clause.
* **Weak copyleft on an unmodified, dynamically loaded library is acceptable with a recorded
  exception and a notice.** That is exactly one item: `libvips`, `LGPL-3.0-or-later`, reaching us as
  Next.js → `sharp` (optional) → `@img/sharp-libvips-*` (optional). LGPL on a library we neither
  modify nor statically link obliges us to (a) give notice, (b) supply its source or a written offer,
  and (c) not prevent the user replacing it. Shipping the untouched npm tarball inside the image
  satisfies (c) trivially and (b) by pointing at upstream. If the Owner ever wants zero copyleft in a
  published image, R-16 F4 records the exit: install with `--no-optional` and set
  `images: { unoptimized: true }` in `next.config.js`, both documented Next.js self-hosting escapes.
* **File-level weak copyleft in the build tree is acceptable and is never redistributed.**
  `lightningcss` (`MPL-2.0`) is a devDependency; we ship no devDependencies.
* **Attribution-only data licences are acceptable in prod with a `NOTICE` entry.** `caniuse-lite`
  (`CC-BY-4.0`).
* **Non-commercial and share-alike content licences are DENY**, not REVIEW: `CC-BY-NC-4.0` and
  `CC-BY-SA-4.0`. So are the source-available licences `SSPL-1.0`, `BUSL-1.1` and `Elastic-2.0`,
  which are not open source and are incompatible with a product an operator self-hosts and modifies.
* **The GPL that exists in this product's world is at the OS level, and it stays out of what we
  publish.** Spec A.3 lists `bubblewrap` (LGPL-2.1-or-later) and `socat` (GPL-2.0 with an OpenSSL
  linking exception) as `PATH` prerequisites for the `sandbox-runtime` driver. Those are separate
  executables on the *user's own machine*, installed by the user's own package manager; we
  redistribute nothing. **The published images of A.2 must never contain `bubblewrap` or `socat`.**
  They are for the `docker` and `kubernetes` drivers and need neither. R-16 F6 notes that this is
  currently an accident of design; here it is a rule.
* **The repository `LICENSE` (Apache-2.0, D-01) covers our source and nothing else.** It cannot and
  does not relicense the Agent SDK, libvips, or the Debian userland in the base image. The `NOTICE`
  file and the OCI image label
  `org.opencontainers.image.licenses="Apache-2.0 AND LicenseRef-Anthropic-Commercial"` carry the rest
  (R-16 C.4).

---

## 6. Third-party sandbox vendor SDKs never leak past the driver boundary

Spec A.9 names five vendors shipping six npm packages: `e2b`, `@e2b/code-interpreter`,
`@daytonaio/sdk`, `modal`, `@vercel/sandbox`, `@cloudflare/sandbox`. R-16 F7 probed all six: every one
is MIT or Apache-2.0. **Licence is therefore not the constraint here, and that is the danger** — a
permissive licence removes the one friction that might otherwise have stopped an engineer adding one
on a whim.

The constraint is architectural (spec §14.4: "Do not create a package per vendor. Do not let a vendor
SDK type leak past the driver boundary") and it is enforced mechanically, because a licence gate
cannot express it:

1. **All six package names are on `denyByName`**, checked at stage 0 before any licence verdict and
   before the exception lookup. Adding any of them fails CI with exit 1 even though its licence is on
   the ALLOW list. Demonstrated live on 2026-09-03: `pnpm add e2b @vercel/sandbox` in a scratch tree
   produced two DENY rows and exit 1.
2. **`denyByName` is not clearable by an exception.** Removing a name is a D-09 decision recorded in
   the plan — plan §11 D-09's default is that the `external` driver is *not offered* — never an edit
   in a feature PR.
3. **If D-09 flips**, the vendor SDK becomes a dependency of exactly one file:
   `packages/runtime/src/managed/external.ts` (spec §29). Enforce it with the same import-boundary
   test plan §9.1 already specifies for the Agent SDK (`no-sdk-import`), extended with one rule per
   vendor package. That test does not exist yet; it lands with the driver.
4. **No vendor type crosses the driver boundary.** The driver interface of spec §14.2 is the only
   exported surface; the vendor's `Sandbox`, `Session` or handle types stay local. `tsc` will not
   catch a leaked structural type, so the boundary test asserts on **imports**, not types.
5. **One `external` driver, one `provider` field.** Not one package per vendor.
6. **A new vendor requires a new row in the Owner decision log**, not a new dependency in a feature PR.

---

## 7. `@anthropic-ai/claude-agent-sdk` publishes no SPDX identifier

The SDK the product exists to run declares `"license": "SEE LICENSE IN README.md"`. R-16 F2 probed it:
the README contains no licence section at all, and the shipped `LICENSE.md` reads, in full,
"© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here:
https://code.claude.com/docs/en/legal-and-compliance." It is **the only proprietary component in the
product**, and it is not pure JavaScript: it resolves a per-platform compiled `claude` binary through
eight `optionalDependencies`, each carrying the same all-rights-reserved licence.

What the policy does about it, concretely:

* **`SEE LICENSE IN README.md` is not an SPDX expression and never passes.** It fails to parse; it
  carries no denied identifier, so it is REVIEW. `pnpm licenses list` does not even report that
  string — it reports the literal key **`Unknown`**, which is likewise REVIEW.
* **It is cleared by a named exception, not by a policy list.** Putting it on `review` or on an ALLOW
  list would describe a mechanism that is not the one doing the work, and would apply to any other
  package with the same unreadable string. The exception is scoped to the two package patterns, names
  Owner (D-13) as the reviewer, states in its `reason` that the package is proprietary, and expires.
* **`Unknown` must never pass silently.** It is where a proprietary package hides — R-16 F9 records
  that `taffydb@2.6.2`, which declares no licence at all, lands under the same key. The gate treats
  the key as REVIEW and requires a named exception, so a *new* `Unknown` package fails CI rather than
  inheriting the SDK's clearance.
* **Redistribution is a live Owner decision, D-13**, raised by R-16 and not settled here. Until it is
  decided, the position W0-INF-03 declares is R-16's: the images we publish do **not** bake the SDK
  in; the Dockerfile installs it from npm at build time on the operator's own machine. The exception's
  `reason` says the SDK must be installed unmodified and never vendored or patched, which is a
  condition of Anthropic's legal page, not a preference.
* **Related, and also D-13:** the A.11 gateway may hold an Anthropic API key or a third-party
  inference-provider credential and **nothing else** — never a Claude.ai subscription credential or
  session token. That is a constraint on the design, not on the dependency tree, and it is recorded
  here only because R-16 found it while reading the same licence page.

---

## 8. How R-16's six residual findings were closed

[ADR-0005](adr/0005-r16-residual-findings-resolved-in-implementation.md) routed six residual findings
from R-16's third fact-check into this task, to be closed in code rather than in a fourth research
round. Each is closed below. "Fixture" means a case in `node scripts/check-licenses.mjs --self-test`
that fails on the old behaviour and passes on the new one, run by CI on every push and pull request.

| # | Finding | Closed by |
| --- | --- | --- |
| N1 | Stale `shadcn` version row: 4.20.0 recorded, 4.20.1 published 2026-09-02T16:36:54Z, before the probe date | Re-probed 2026-09-03 (`npm view shadcn version` → `4.20.1`; `npm view shadcn@4.20.1 license` → `MIT`) and corrected in R-16 F1, with both publish timestamps. MIT and ALLOW at both versions, so nothing in CI changes. **Note-only.** |
| N2 | "Load-bearing / defensive" carried two senses in one block; stage 3 headed *Load-bearing* and stage 4 *Defensive* although the deletion probe puts both in the same bucket | R-16 C.1 now asks the two questions separately — *deletion-neutral or verdict-changing*, and *behaviour-critical or not* — and every stage 0–6 carries both answers. Stage 3 is the one stage where they differ. **Note-only**, but the behaviour is pinned in code: the parse-failure branch returning something other than a non-pass verdict fails several fixtures. |
| N3 | "All identifiers this policy uses exist on SPDX 3.28.0" listed 16; the policy uses 30, and the sentence was wrong about `UNLICENSED` | All 30 checked mechanically against `v3.28.0/json/licenses.json`: present, none deprecated; `UNLICENSED` confirmed absent. **Fixture:** the self-test flattens the policy, asserts the count is 30, asserts membership of a verified list, and asserts `UNLICENSED` is on `denyLiteral` and nowhere else. |
| N4 | `GPL-2.0-only WITH <OpenSSL exception>` throws, and no standard SPDX exception id exists for socat's | Decided as two questions. *In the policy* it is an error — **fixture:** every `allow`/`allowDev`/`review` entry must parse. *In the inventory* it is DENY, not REVIEW, because a REVIEW can be cleared by an exception — **fixture:** the string classifies DENY and the reason names `GPL-2.0-only`, plus a property fixture that salvage can never produce ALLOW. Reasoning: [ADR-W0-INF-03 · unparseable SPDX expressions](adr/W0-INF-03-unparseable-spdx-expressions.md). |
| N5 | R-16 C.5 rule 2 invented `packages/runtime/src/drivers/external/<provider>.ts` | Corrected in R-16 to `packages/runtime/src/managed/external.ts`, which is what spec §29 lays out and what C.5's own rule 4 implies. **Note-only** — the one finding ADR-0005 sends to the note rather than to the code. Restated as rule 3 of §6 above. |
| N6 | `matchException` keyed on package NAME only, so the `licence` field every exception carries was never compared: an exception granted for one licence silently cleared the package under any other | `matchException` now takes the licence and returns the entry only for the exact string it was granted for; a mismatch is reported as an unmatched REVIEW naming the licence the exception does cover. **Fixture,** in both forms: the unit case (`caniuse-lite` + `MPL-2.0` does not match a `CC-BY-4.0` exception) and the end-to-end case (an inventory in which `caniuse-lite` has relicensed passes under the old behaviour and fails under the new one). |

Four further defects were found while closing these, none in the residual list, all now encoded:

* **`@img/sharp-wasm32@0.35.4` declares `Apache-2.0 AND LGPL-3.0-or-later AND MIT`**, a three-way
  conjunction that appears nowhere in R-16. It would have reached REVIEW with no exception and failed
  the gate on any platform with no native `sharp` binding. Probed 2026-09-03; added to REVIEW and
  given an exception. `@img/sharp-win32-arm64` and `-ia32` were probed at the same time and carry the
  same string as `-x64`, so that exception is a wildcard rather than an exact name.
* **The `MIT AND GPL-3.0-only` gap R-16 C.1 stage 5 documents is closed**, not merely disclosed — see
  §3. It was a limitation of `satisfies(expr, [family])`, not of the policy.
* **The seven deprecated single-identifier `WITH` spellings classified REVIEW, not DENY** — the same
  laundering shape as N4, arriving through a string that *does* parse rather than one that does not.
  Closed by stage N of §3. **Fixture:** the map is asserted to hold exactly the seven deprecated
  `-with-` identifiers on SPDX 3.28.0; each normalisation is asserted against the replacement SPDX's
  own `licenseComments` names; each of the seven has its own named DENY case; an inventory in which a
  package declares `GPL-2.0-with-classpath-exception` **and carries an exception granted for exactly
  that string** still comes out DENY; and an unrecognised `-with-` spelling denies on its base.
* **An exception with a missing or unreadable `expires` cleared its package permanently** — see §4.
  **Fixture:** five shapes (`undefined`, `''`, `'soon'`, `null`, `90`) each produce a row saying the
  expiry is unreadable, and a readable future expiry still clears.

---

## 9. Adding a dependency, in practice

1. Answer spec §40's question. If the answer is "yes, ~50 lines", write the 50 lines.
2. Check the licence before adding it: `npm view <pkg> version license`.
3. Add it, run `pnpm install`, and run `node scripts/check-licenses.mjs` locally. It inspects the
   installed tree, so a transitive licence you did not expect shows up here rather than in CI.
4. If a package lands in REVIEW, do **not** widen a policy list. Read its actual licence file, then
   add an exception with a reviewer, a reason, the exact licence string and an expiry.
5. If a package lands in DENY, remove it. A DENY is not clearable by an exception, and changing the
   policy is an ADR, not a PR comment.
6. `pnpm-lock.yaml` is owned by the wave's first task ([ADR-0009](adr/0009-pnpm-lock-ownership-exception.md)).
   A later task in the same wave that needs a new dependency escalates rather than editing it in
   parallel.

## 10. Re-verification

**2026-12-02**, which is R-16's re-verify date and every exception's expiry, so the gate enforces it
rather than a calendar. At that point: re-read the Agent SDK's `LICENSE.md` and
https://code.claude.com/docs/en/legal-and-compliance (Anthropic can change either without a semver
signal); confirm `@img/sharp-libvips-*` is still `LGPL-3.0-or-later` and still optional; re-run the
gate against a fresh lockfile, because a transitive licence can change without any direct dependency
changing; and re-read `denyByName` against D-09's current state.

One thing is due **before** that date rather than at it: every probe behind this policy, and every
local run of the gate, was executed on a single Windows 11 / win32-x64 host, and `sharp`'s platform
packages are `os`-gated — a Linux install resolves `@img/sharp-linux-x64` (`Apache-2.0`) plus
`@img/sharp-libvips-linux-x64` (`LGPL-3.0-or-later`) where win32 resolves the bundled
`@img/sharp-win32-x64`. Both shapes are covered by the register, but the Linux shape was established
from registry metadata, not from an installed Linux tree. The first green CI run of this gate on
`ubuntu-latest` is that evidence.

## 11. Build-time tools outside the npm tree: the Lean specification

The formal specification in `formal/` ([ADR-0062](adr/0062-the-specification-is-a-lean-4-model-and-typescript-is-tested-against-it.md))
is built by a toolchain that is not an npm dependency and is never shipped. The licence gate does
not see it, so it is recorded here. Each licence was checked through the GitHub licence API on
2026-09-23.

| Component | Pinned at | Licence | How it arrives |
| --- | --- | --- | --- |
| elan (toolchain manager) | `v4.2.4`. The Linux archive's SHA-256 `42b94d42…1f63` is verified in CI | Apache-2.0 | release archive, checksum-verified |
| Lean 4 (compiler, Lake, core library) | `v4.34.0` (`formal/lean-toolchain`) | Apache-2.0 | installed by elan from the official release |
| Batteries | `f2effa3d803fda822b1f97b806c47cf2adfbcbc2` (tag `v4.34.0`) | Apache-2.0 | Lake git dependency, pinned in `formal/lake-manifest.json` |
| Plausible | `118aa17ee84656b8bd727fef7c458ee8c833385c` (tag `v4.34.0`) | Apache-2.0 | Lake git dependency, pinned in `formal/lake-manifest.json` |

Adding a Lake dependency (Mathlib in particular) follows §9's questions, and it needs an ADR that
shows a theorem needs it.
