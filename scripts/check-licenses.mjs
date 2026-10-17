#!/usr/bin/env node
// Licence gate — the development plan §9.1.
//
// Reads the installed dependency tree with `pnpm licenses list --json -r`, classifies every
// package ALLOW / REVIEW / DENY against the SPDX policy below, and exits non-zero on any DENY
// and on any REVIEW that has no recorded exception. Zero dependencies, plain Node ESM. The SPDX
// tokeniser, parser, canonicaliser and evaluator are 210 lines of code between them
// (re-counted 2026-09-03 after the case-canonicalisation change, over `tokenise`, `parseSpdx`,
// `spdxSpellingRegistry`, `spellCanonically`, `canonicaliseSpdx`, `canonicalLicence`,
// `canonicalString`, `canonicalSet`, `expressionSatisfies`, `expressionDenied` and
// `salvageDenied`, excluding comments and blank lines). That is over spec §40's
// "approximately 50 lines of TypeScript" threshold, so
// §40 does not by itself say to write this rather than depend on it — what decides is ownership:
// the repository root and `package.json` are outside this task, so a dependency cannot be added
// here at all. §40's exclusion list (cryptography, JWT, OAuth, database clients, container
// protocols) does not cover an SPDX evaluator, and R-16 F10 defect 2 records the cost of the
// other direction — a gate whose own dependencies need a policy exemption fails on itself on its
// first run. Reasoning and the reversal path: docs/adr/W0-INF-03-policy-lives-in-the-gate.md.
//
//   node scripts/check-licenses.mjs
//       The redistributed tree (`--prod`). This is the blocking gate.
//
//   node scripts/check-licenses.mjs --dev
//       The build-time tree (`--dev`), with `allowDev` unioned into `allow`. Never redistributed,
//       so the policy is looser — but still a gate, not a report.
//
//   node scripts/check-licenses.mjs --engine <engine id>
//       One runtime image's tree (ENG-07, docs/adr/0073-one-runtime-image-per-engine.md): the
//       production dependencies of `@agent-workspace/runner` and `@agent-workspace/engine-<id>`,
//       which is what `runtime.Dockerfile` installs for that engine. Same policy as `--prod`.
//
//   node scripts/check-licenses.mjs --self-test
//       Run the built-in fixtures for the SPDX parser, the classifier, exception matching and
//       the whole-inventory evaluator, and exit non-zero on any failure. Requires no network,
//       no node_modules and no pnpm. `.github/workflows/ci.yml` runs it in the licence step,
//       ahead of the two live runs, so a broken checker is reported as a broken checker rather
//       than as a passing gate. It is not covered by `pnpm test`: vitest.config.ts sets
//       projects to 'apps/*' and 'packages/*', so scripts/ is not a Vitest project at all.
//
// The policy and the exception register live in this file rather than in root-level
// `licence-policy.json` / `licence-exceptions.json` as R-16 C.3 sketched. Two reasons, both
// recorded in docs/adr/W0-INF-03-policy-lives-in-the-gate.md: the root of the repository is not
// in this task's file ownership, and an inlined policy is what makes `--self-test` hermetic.
// The prose half of the policy — the copyleft position, the reviewer for each exception, and how
// each of R-16's six residual findings was closed — is docs/dependency-policy.md.

/* global console, process */ // The root ESLint config declares no environment globals.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ── The policy ──────────────────────────────────────────────────────────────────────────
// R-16 Appendix C.1. Every identifier here is written in its registered SPDX spelling, and
// every one of the 30 was re-verified against SPDX License List 3.28.0 (released 2026-02-20,
// 727 licences) on 2026-09-03. **The spelling below is the canonical one, not the only one that
// matches**: SPDX identifiers are case-insensitive, and `canonicaliseSpdx` folds an incoming
// licence string onto these spellings before anything is compared. R-16 F8 recorded
// `spdx-satisfies@6.0.0` throwing on `mit`; this gate classifies it as MIT instead, and the
// divergence is written up in that note.
//
// The self-test re-checks the list on every run: `policyIdentifiers` flattens every list below
// into its individual identifiers, and the `R-16 residual 3` checks assert the count, membership
// of the verified 3.28.0 list, that `UNLICENSED` is not among them, and that `UNLICENSED` is on
// `denyLiteral` where a non-SPDX string belongs.
// `UNLICENSED` is the one string here that is NOT an SPDX identifier, which is exactly why it
// lives in `denyLiteral` and nowhere else.

export const POLICY = {
  // Evaluated as an SPDX expression, so `(BSD-3-Clause OR GPL-2.0)` passes on the BSD disjunct:
  // OR is the licensee's choice and we take BSD-3-Clause.
  allow: [
    'MIT',
    'MIT-0',
    'ISC',
    'Apache-2.0',
    'BSD-2-Clause',
    'BSD-3-Clause',
    '0BSD',
    'Unlicense',
    'CC0-1.0',
    'BlueOak-1.0.0',
    'Python-2.0',
    'PostgreSQL',
  ],

  // Unioned into `allow` for the --dev run only. The dev tree is never redistributed.
  // MPL-2.0 is lightningcss (via vitest → vite). CC-BY-3.0 and CC-BY-4.0 are data and
  // documentation licences. Being on this list does NOT mean they reach only build-time
  // tooling: `caniuse-lite@1.0.30001810` is CC-BY-4.0 and is in the redistributed `--prod`
  // tree, inside Next.js. It is cleared there by a recorded exception with a NOTICE
  // obligation, not by this list, which the `--prod` run never consults.
  allowDev: ['MPL-2.0', 'CC-BY-3.0', 'CC-BY-4.0'],

  // Exact match on the licence string as pnpm reports it. Clearable by a recorded exception.
  // "Unknown" deliberately does NOT appear here, but not because it fails to parse — it parses
  // fine, as a bare identifier, and comes out REVIEW at stage 6 with the reason `on none of the
  // policy lists`. R-16 recorded it as a parse failure because spdx-satisfies threw on it; this
  // hand-written parser does not. It is left off because listing it would read as a considered
  // judgement about a licence, and "Unknown" is the absence of one.
  review: [
    'MPL-2.0',
    'EPL-2.0',
    'CDDL-1.0',
    'CC-BY-4.0',
    'CC-BY-3.0',
    'LGPL-2.1-or-later',
    'LGPL-3.0-or-later',
    'Apache-2.0 AND LGPL-3.0-or-later',
    // Probed 2026-09-03, and not in R-16: `@img/sharp-wasm32@0.35.4` declares a three-way
    // conjunction. Same libvips, plus the MIT-licensed Emscripten runtime.
    'Apache-2.0 AND LGPL-3.0-or-later AND MIT',
  ],

  // Matched against the canonical form of each licence in the expression, so the DEPRECATED
  // identifiers an exact-match list misses are caught too: `GPL-3.0`, `GPL-3.0+`, `AGPL-3.0`
  // and `GPL-2.0` all canonicalise onto an entry here, and the seven deprecated
  // `GPL-N.0-with-<something>-exception` spellings are normalised into a `WITH` expression
  // whose base is one of these before anything is looked up. Not clearable by an exception.
  denyFamilies: [
    'GPL-2.0-only',
    'GPL-2.0-or-later',
    'GPL-3.0-only',
    'GPL-3.0-or-later',
    'AGPL-3.0-only',
    'AGPL-3.0-or-later',
  ],

  // Exact string match, checked first. All six parse as SPDX expressions — the reason they are
  // matched literally rather than left to the expression stages is that five of them are
  // source-available or non-commercial rather than open source, and the sixth, `UNLICENSED`, is
  // npm's convention for no licence grant at all and is not an SPDX identifier. Not clearable
  // by an exception.
  denyLiteral: [
    'SSPL-1.0',
    'BUSL-1.1',
    'Elastic-2.0',
    'CC-BY-NC-4.0',
    'CC-BY-SA-4.0',
    'UNLICENSED',
  ],

  // PACKAGE NAMES, not licences (spec A.9, plan D-09). Every package here is MIT or Apache-2.0
  // — R-16 F7 probed all six — so a licence-only gate waves all of them through. This key is
  // the whole of the enforcement behind R-16 C.5 rule 1 while D-09's default ("the `external`
  // driver is not offered") stands. Trailing `*` is a prefix match. Not clearable by an
  // exception; removing an entry is a D-09 decision recorded in the plan, not an edit in a
  // feature PR.
  denyByName: [
    'e2b',
    '@e2b/code-interpreter',
    '@daytonaio/sdk',
    'modal',
    '@vercel/sandbox',
    '@cloudflare/sandbox',
  ],
};

// ── The exception register ──────────────────────────────────────────────────────────────
// R-16 Appendix C.2, with one change that closes R-16 residual finding 6: `licence` is now
// COMPARED, not merely recorded. An exception clears a package only for the licence string it
// was granted for. An exception whose `licence` no longer matches what pnpm reports is
// reported as unmatched, i.e. the gate fails — a relicensing is a re-review, not a silent pass.
//
// `licence` is the string pnpm reports (which for an unresolvable licence is the literal
// "Unknown"); `actual` is what the package really is, for the human reading the table.
// A trailing `*` in the key is a prefix match on the package name.

export const EXCEPTIONS = {
  '@img/sharp-libvips-*': {
    licence: 'LGPL-3.0-or-later',
    scope: 'prod',
    reviewer: 'Owner (D-01)',
    reason:
      'Prebuilt libvips, loaded dynamically and unmodified by sharp, itself an optional dependency of Next.js. Weak copyleft; no obligation on our source. NOTICE must state the licence and offer the upstream tarball.',
    expires: '2026-12-02',
  },
  '@img/sharp-win32-*': {
    licence: 'Apache-2.0 AND LGPL-3.0-or-later',
    scope: 'prod',
    reviewer: 'Owner (D-01)',
    reason:
      'The same libvips, bundled into the platform package rather than split out, on all three win32 architectures. Never present in a published Linux image.',
    expires: '2026-12-02',
  },
  '@img/sharp-wasm32': {
    licence: 'Apache-2.0 AND LGPL-3.0-or-later AND MIT',
    scope: 'prod',
    reviewer: 'Owner (D-01)',
    reason:
      'The same libvips again, compiled to wasm, plus the MIT Emscripten runtime. Resolved only where no native binding exists. Probed 2026-09-03; not recorded in R-16.',
    expires: '2026-12-02',
  },
  'caniuse-lite': {
    licence: 'CC-BY-4.0',
    scope: 'prod',
    reviewer: 'Owner (D-01)',
    reason:
      'Browser-support data shipped inside Next.js. Attribution-only; satisfied by the NOTICE file.',
    expires: '2026-12-02',
  },
  '@anthropic-ai/claude-agent-sdk': {
    licence: 'Unknown',
    actual: 'PROPRIETARY — © Anthropic PBC, all rights reserved ("SEE LICENSE IN README.md")',
    scope: 'prod',
    reviewer: 'Owner (D-13)',
    reason:
      'The product exists to run this SDK (spec §28). Not open source. Redistribution inside our published images is governed by https://code.claude.com/docs/en/legal-and-compliance and is subject to D-13. Must be installed unmodified from npm at image build time, never vendored or patched.',
    expires: '2026-12-02',
  },
  '@anthropic-ai/claude-agent-sdk-*': {
    licence: 'Unknown',
    actual: 'PROPRIETARY — © Anthropic PBC, all rights reserved',
    scope: 'prod',
    reviewer: 'Owner (D-13)',
    reason:
      'Per-platform compiled `claude` binary resolved by the SDK through eight optionalDependencies. Same terms as above.',
    expires: '2026-12-02',
  },
};

// ── SPDX expression parsing ─────────────────────────────────────────────────────────────
// SPDX v2.3 grammar, precedence `+` > WITH > AND > OR:
//
//   or-expr   := and-expr ( 'OR' and-expr )*
//   and-expr  := with-expr ( 'AND' with-expr )*
//   with-expr := simple ( 'WITH' exception-id )?
//   simple    := id [ '+' ] | 'LicenseRef-…' | '(' or-expr ')'
//
// Operators are case-sensitive and upper-case. Identifiers are NOT: SPDX matches them
// case-insensitively, and `canonicaliseSpdx` has already folded them onto their registered
// spelling before this parser sees them, so the parser itself can stay exact. A string that
// is not a valid expression throws — `parse` never guesses. The thrown message deliberately
// takes the same shape R-16 F8 recorded from spdx-satisfies (``Unexpected `X` at offset N``)
// so the run logs in that note and the output of this script read alike.
//
// AST: { op: 'or'|'and', left, right } | { op: 'with', base, exception } |
//      { op: 'lic', id, orLater } | { op: 'ref', id }

const ID_CHAR = /[A-Za-z0-9.-]/;

class SpdxParseError extends Error {}

function tokenise(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '(' || c === ')' || c === '+') {
      tokens.push({ value: c, offset: i });
      i++;
      continue;
    }
    if (ID_CHAR.test(c)) {
      const start = i;
      while (i < source.length && ID_CHAR.test(source[i])) i++;
      tokens.push({ value: source.slice(start, i), offset: start });
      continue;
    }
    throw new SpdxParseError(`Unexpected \`${c}\` at offset ${i}`);
  }
  return tokens;
}

// A bare identifier must look like an SPDX id: it starts with a letter or digit. `WITH`,
// `AND` and `OR` are operators, never identifiers, so they are rejected here.
const LICENCE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const OPERATORS = new Set(['AND', 'OR', 'WITH']);

export function parseSpdx(source) {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new SpdxParseError('Unexpected end of expression at offset 0');
  }
  const tokens = tokenise(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const endOffset = () => (tokens.length ? tokens[tokens.length - 1].offset : 0);

  function expectIdentifier(what) {
    const t = peek();
    if (!t) throw new SpdxParseError(`Unexpected end of expression at offset ${endOffset()}`);
    if (!LICENCE_ID.test(t.value) || OPERATORS.has(t.value)) {
      throw new SpdxParseError(`Unexpected \`${t.value[0]}\` at offset ${t.offset} (${what})`);
    }
    pos++;
    return t.value;
  }

  function parseSimple() {
    const t = peek();
    if (!t) throw new SpdxParseError(`Unexpected end of expression at offset ${endOffset()}`);
    if (t.value === '(') {
      pos++;
      const inner = parseOr();
      const close = peek();
      if (!close || close.value !== ')') {
        throw new SpdxParseError(`Unexpected end of expression at offset ${endOffset()}`);
      }
      pos++;
      return inner;
    }
    const id = expectIdentifier('licence identifier');
    let orLater = false;
    if (peek() && peek().value === '+') {
      pos++;
      orLater = true;
    }
    if (id.startsWith('LicenseRef-') || id.startsWith('DocumentRef-')) {
      return { op: 'ref', id };
    }
    return { op: 'lic', id, orLater };
  }

  function parseWith() {
    const left = parseSimple();
    if (peek() && peek().value === 'WITH') {
      pos++;
      const exception = expectIdentifier('licence-exception identifier');
      return { op: 'with', base: left, exception };
    }
    return left;
  }

  function parseAnd() {
    let node = parseWith();
    while (peek() && peek().value === 'AND') {
      pos++;
      node = { op: 'and', left: node, right: parseWith() };
    }
    return node;
  }

  function parseOr() {
    let node = parseAnd();
    while (peek() && peek().value === 'OR') {
      pos++;
      node = { op: 'or', left: node, right: parseAnd() };
    }
    return node;
  }

  const ast = parseOr();
  const trailing = peek();
  if (trailing) {
    throw new SpdxParseError(
      `Unexpected \`${trailing.value[0]}\` at offset ${trailing.offset} (trailing input)`,
    );
  }
  return ast;
}

// ── Deprecated identifiers ──────────────────────────────────────────────────────────────
// SPDX deprecates identifiers rather than deleting them, and npm packages published before a
// deprecation still carry the old spelling — `ccnetviz@1.0.19` declares `GPL-3.0`, and R-16 F10
// defect 1 is exactly a deny list that missed that. The deprecated set on SPDX License List
// 3.28.0 (fetched 2026-09-03 from `spdx/license-list-data` at tag `v3.28.0`) has 32 members and
// splits in two:
//
//   * The version-suffix forms — `GPL-2.0`, `GPL-2.0+`, `GPL-3.0`, `GPL-3.0+`, `AGPL-3.0`,
//     `LGPL-2.1`, `LGPL-3.0+` and so on. Their replacement is derivable: `X` → `X-only`,
//     `X+` → `X-or-later`. `GNU_FAMILY` below is that derivation.
//   * The seven single-identifier `WITH` forms, whose replacement is NOT derivable, because the
//     exception half carries its own version: `GPL-2.0-with-GCC-exception` becomes
//     `GCC-exception-2.0` but `GPL-3.0-with-GCC-exception` becomes `GCC-exception-3.1`, and
//     `GPL-2.0-with-bison-exception` becomes `Bison-exception-2.2`. Those have to be read off
//     the list, so they are the map below.
//
// The seven replacements are transcribed verbatim from each identifier's own
// `json/details/<id>.json` at `v3.28.0`, field `licenseComments`, which reads
// `DEPRECATED: Use license expression including main license, "WITH" operator, and identifier:
// <exception-id>`. The main licence is the deprecated identifier's own base in its current
// spelling (`GPL-2.0` → `GPL-2.0-only`). Every exception id below was checked against
// `json/exceptions.json` at the same tag (84 exceptions); the self-test re-asserts that the
// map has exactly these seven keys, that each replacement parses, and that each is DENY.
//
// This map is not guessed. If SPDX deprecates more identifiers, the way to extend it is to
// re-read the list, not to pattern-match a spelling. Reasoning and the rejected alternatives:
// docs/adr/W0-INF-03-a-review-verdict-is-a-door-and-every-way-to-reach-it-is-a-lock.md.

export const DEPRECATED_SPDX_WITH_FORMS = {
  'GPL-2.0-with-autoconf-exception': 'GPL-2.0-only WITH Autoconf-exception-2.0',
  'GPL-2.0-with-bison-exception': 'GPL-2.0-only WITH Bison-exception-2.2',
  'GPL-2.0-with-classpath-exception': 'GPL-2.0-only WITH Classpath-exception-2.0',
  'GPL-2.0-with-font-exception': 'GPL-2.0-only WITH Font-exception-2.0',
  'GPL-2.0-with-GCC-exception': 'GPL-2.0-only WITH GCC-exception-2.0',
  'GPL-3.0-with-autoconf-exception': 'GPL-3.0-only WITH Autoconf-exception-3.0',
  'GPL-3.0-with-GCC-exception': 'GPL-3.0-only WITH GCC-exception-3.1',
};

// A GNU-family identifier carrying a `-with-<something>` tail that is NOT one of the seven —
// a misspelling, a future deprecation, or an npm author's invention. It is still a single
// identifier naming a GPL base, so it is still expanded to `<base> WITH <tail>`; the base is
// what decides, and an unrecognised exception half can only ever make the verdict stricter.
//
// Case-insensitive, because `GPL-3.0-WITH-SOMETHING-EXCEPTION` is one token (no spaces, so the
// `WITH` inside it is not an operator) and an uppercase spelling of an invented exception must
// not be the one that escapes. The family is re-emitted upper-case, which is its registered
// spelling; the tail is left exactly as it arrived, because it names nothing we know.
const GNU_WITH_FORM = /^((?:A|L)?GPL)-(\d+\.\d+)-with-(.+)$/i;

// A run of characters the SPDX tokeniser would read as one identifier, plus a trailing `+`.
// The `+` is here for `salvageDenied`, which reads tokens out of a string that did NOT parse and
// has to see `GPL-2.0+` whole rather than as `GPL-2.0` followed by a stray operator; it strips
// the `+` itself and passes `orLater` to `canonicalLicence`, which does not accept a `+` in the
// identifier. The deprecated-`WITH` rewrite does not need the `+` — no deprecated `WITH` form
// carries one — but the two share this regex so a string cannot be scanned one way and
// normalised another.
const IDENTIFIER_RUN = /[A-Za-z0-9][A-Za-z0-9.+-]*/g;

// ── The identifier registry: one spelling per licence ───────────────────────────────────
// SPDX matches licence and exception identifiers CASE-INSENSITIVELY. npm's `license` field is
// whatever the package author typed and pnpm reports it verbatim, so `MIT`, `mit` and `MiT` all
// arrive here naming the same licence — and so do `gpl-2.0-with-classpath-exception` and
// `GPL-2.0-WITH-CLASSPATH-EXCEPTION`, which before this registry came out REVIEW (clearable by
// a recorded exception) where the canonically-cased spelling came out DENY. That is the fourth
// instance of one defect: a door reachable by a spelling nobody thought to try.
//
// Fixed by CANONICALISING AT THE BOUNDARY rather than by comparing case-insensitively at each
// site. There are eight downstream comparisons — `denyLiteralSet` twice in `classify`,
// `reviewSet` twice, `allowSet` via `expressionSatisfies`, `denySet` via `expressionDenied`,
// and `denyLiteralSet` and `denySet` again in `salvageDenied` — and a case-insensitive compare
// bolted onto each would leave the ninth for the next verifier to find. The case decision is
// taken ONCE, here, on the way in; everything after this point sees exactly one spelling and
// can go on comparing exactly.
//
// **A gate decides on a positive assertion, never on the absence of a negative.** This registry
// does not ask "is this token spelled like something we deny?" — it asks "IS this token one of
// the identifiers this policy knows?", and when it is, replaces it with that identifier's one
// registered spelling. A token the registry does not recognise is passed through EXACTLY as it
// arrived: it is not a licence we know, so it must reach REVIEW as an unknown rather than be
// massaged into something that looks decidable. Over-reach in the other direction would be the
// same bug wearing the opposite coat.

let spdxSpellings = null;

// Every identifier this policy can recognise, keyed by its lower-case form. Built from the
// verified 3.28.0 list, the policy's own lists, the deprecated `WITH` map on both sides, and
// the deprecated bare GNU forms derived from the family identifiers already registered.
function spdxSpellingRegistry() {
  if (spdxSpellings) return spdxSpellings;
  const map = new Map();
  const register = (id) => {
    const key = id.toLowerCase();
    const seen = map.get(key);
    // Two registered spellings differing only by case would make canonicalisation ambiguous,
    // and SPDX's own case-insensitivity forbids it. Fail loudly rather than silently pick one.
    if (seen !== undefined && seen !== id) {
      throw new Error(`SPDX registry collision: \`${seen}\` and \`${id}\` differ only by case`);
    }
    map.set(key, id);
  };
  // Operators are NOT registered. They are case-sensitive in SPDX, and folding `or` up to `OR`
  // would turn an invalid expression into a valid one — `GPL-3.0 or MIT` is unparseable today
  // and is denied by the salvage scan, but as `GPL-3.0-only OR MIT` it would be ALLOW. That is
  // a laundering direction, so operator case is left exactly as it arrived.
  const identifiersIn = (entry) =>
    (entry.match(IDENTIFIER_RUN) ?? []).filter((t) => !OPERATORS.has(t));

  for (const id of SPDX_3_28_0_IDENTIFIERS_USED_BY_THIS_POLICY) register(id);
  for (const key of ['allow', 'allowDev', 'review', 'denyFamilies', 'denyLiteral']) {
    for (const entry of POLICY[key] ?? []) for (const id of identifiersIn(entry)) register(id);
  }
  for (const [deprecated, current] of Object.entries(DEPRECATED_SPDX_WITH_FORMS)) {
    register(deprecated);
    for (const id of identifiersIn(current)) register(id);
  }
  // The deprecated bare GNU forms — `GPL-3.0` for `GPL-3.0-only`, and so on. Derived from the
  // family identifiers already registered rather than typed out again, so the two cannot drift.
  for (const id of [...map.values()]) {
    const m = GNU_FAMILY.exec(id);
    if (m) register(`${m[1]}-${m[2]}`);
  }
  spdxSpellings = map;
  return map;
}

// GNU-family identifiers in any case, with or without a version suffix. This is the one
// generative rule in the canonicaliser, and it is still a positive assertion: it fires only on a
// token that IS `<family>-<major>.<minor>[-only|-or-later]` for one of the four GNU families,
// and it rebuilds that identifier in its registered spelling. It is here because the GNU family
// is where the deny list lives, so a well-formed but unregistered spelling (`lgpl-2.1`,
// `Agpl-3.0-Only`) must not be the one that gets through.
const GNU_FAMILY_ANY_CASE = /^((?:A|L)?GPL)-(\d+\.\d+)(?:-(only|or-later))?$/i;

// One token → its registered spelling, or the token untouched if we do not know it.
function spellCanonically(token) {
  // `IDENTIFIER_RUN` swallows a trailing `+`, which is not part of the identifier. Split it off,
  // canonicalise the identifier, put it back — `GPL-3.0+` must stay `GPL-3.0+` so the tokeniser
  // still reads the `+` as its own token and `salvageDenied` still sees it whole.
  const plus = token.endsWith('+');
  const bare = plus ? token.slice(0, -1) : token;
  const tail = plus ? '+' : '';
  const registered = spdxSpellingRegistry().get(bare.toLowerCase());
  if (registered) return registered + tail;
  const m = GNU_FAMILY_ANY_CASE.exec(bare);
  if (m) return `${m[1].toUpperCase()}-${m[2]}${m[3] ? `-${m[3].toLowerCase()}` : ''}${tail}`;
  return token;
}

// THE BOUNDARY. Every licence string enters classification through here and nowhere else.
// Two jobs, in this order, both on the way in:
//
//   1. Case-fold each identifier onto its registered SPDX spelling (`spellCanonically`).
//   2. Rewrite every deprecated single-identifier `WITH` form into the current SPDX expression
//      it stands for, so the string parses into a real `with` node.
//
// Step 2 is what closed the first laundering path: `GPL-2.0-with-classpath-exception` is one
// token, so it parses into a `lic` node, and `expressionDenied`'s `with` branch — the branch
// that strips a `WITH` down to its base and denies on the base — is never reached. The whole
// expanded string is looked up in `denySet` instead, is absent, and the package comes out
// REVIEW, which a recorded exception can clear. Rewriting first makes the base decide, and the
// verdict is DENY, which nothing can clear.
//
// Step 1 is what closes the same door in every other case: without it, step 2's map lookup is
// an exact-case match, so `GPL-2.0-WITH-CLASSPATH-EXCEPTION` walked straight past it.
export function canonicaliseSpdx(source) {
  if (typeof source !== 'string') return source;
  return source.replace(IDENTIFIER_RUN, (token) => {
    if (OPERATORS.has(token)) return token;
    const spelt = spellCanonically(token);
    const known = DEPRECATED_SPDX_WITH_FORMS[spelt];
    if (known) return known;
    const m = GNU_WITH_FORM.exec(spelt);
    return m ? `${m[1].toUpperCase()}-${m[2]}-only WITH ${m[3]}` : spelt;
  });
}

// ── Canonical identifiers ───────────────────────────────────────────────────────────────
// The version-suffix half of the deprecation problem: `GPL-3.0` → `GPL-3.0-only` and
// `GPL-3.0+` → `GPL-3.0-or-later`. Checked against SPDX 3.28.0 on 2026-09-03: `GPL-2.0`,
// `GPL-3.0`, `GPL-3.0+`, `AGPL-3.0` and `LGPL-3.0` are all present and all flagged
// `isDeprecatedLicenseId`.
//
// The `-with-` tail is deliberately NOT matched here. It used to be, and the expansion it
// produced (`GPL-2.0-only WITH classpath-exception`, an exception identifier that does not
// exist on any SPDX list) was returned as one string to callers that look it up in a set of
// bare family identifiers, where it never matched. `canonicaliseSpdx` above owns those forms
// now, and it runs early enough for the result to be re-parsed.

const GNU_FAMILY = /^((?:A|L)?GPL)-(\d+\.\d+)(?:-(only|or-later))?$/;

export function canonicalLicence(id, orLater = false) {
  const m = GNU_FAMILY.exec(id);
  if (!m) return id;
  const [, family, version, suffix] = m;
  const later = orLater || suffix === 'or-later';
  return `${family}-${version}-${later ? 'or-later' : 'only'}`;
}

// The canonical string form of a whole node, used only for exact-match lookups against the
// allow list (`X WITH Y` is allowed only when the full string is an allowlist entry — R-16 F8
// records this and it is deliberate: an allowed base licence plus an arbitrary exception is
// not an allowed licence).
function canonicalString(node) {
  switch (node.op) {
    case 'lic':
      return canonicalLicence(node.id, node.orLater);
    case 'ref':
      return node.id;
    case 'with': {
      const base = canonicalString(node.base);
      return `${base} WITH ${node.exception}`;
    }
    default:
      return null; // AND / OR have no single canonical identifier.
  }
}

// ── Evaluation ──────────────────────────────────────────────────────────────────────────

function canonicalSet(identifiers) {
  return new Set(identifiers.map((id) => canonicalLicence(id)));
}

// Does this expression permit us to comply with something on `allowed`?
//   OR  — we choose one side, so either side satisfying is enough.
//   AND — we must comply with both, so both sides must satisfy.
export function expressionSatisfies(node, allowedSet) {
  switch (node.op) {
    case 'or':
      return (
        expressionSatisfies(node.left, allowedSet) || expressionSatisfies(node.right, allowedSet)
      );
    case 'and':
      return (
        expressionSatisfies(node.left, allowedSet) && expressionSatisfies(node.right, allowedSet)
      );
    default: {
      const canonical = canonicalString(node);
      return canonical !== null && allowedSet.has(canonical);
    }
  }
}

// Does this expression oblige us to comply with a denied licence?
//   AND — either side being denied denies the whole expression. This closes the gap R-16 C.1
//         stage 5 documents and could not close with `satisfies(expr, [family])`:
//         `MIT AND GPL-3.0-only` is now DENY, not REVIEW.
//   OR  — only if BOTH sides are denied, because we choose. This is what keeps `node-forge`'s
//         `(BSD-3-Clause OR GPL-2.0)` out of the deny bucket regardless of check order.
//   WITH — the base licence decides. `GPL-2.0-only WITH Classpath-exception-2.0` is still GPL
//         unless the policy names the full string on `allow` or `review`, both of which are
//         consulted before this function is.
export function expressionDenied(node, deniedSet) {
  switch (node.op) {
    case 'or':
      return expressionDenied(node.left, deniedSet) && expressionDenied(node.right, deniedSet);
    case 'and':
      return expressionDenied(node.left, deniedSet) || expressionDenied(node.right, deniedSet);
    case 'with':
      return expressionDenied(node.base, deniedSet);
    case 'ref':
      return false; // A LicenseRef cannot be matched to a family. It falls through to REVIEW.
    default:
      return deniedSet.has(canonicalLicence(node.id, node.orLater));
  }
}

// A licence string that does not parse is never a pass — but "REVIEW" is not conservative
// enough on its own, because a REVIEW can be cleared by a recorded exception. So before
// settling on REVIEW we scan the unparseable string for identifier-shaped tokens and deny it
// if any of them is a denied licence. This is what makes R-16's socat row
// (`GPL-2.0-only WITH <OpenSSL exception>`, which throws at the `<`) come out DENY rather than
// as a reviewable string with GPL hiding inside it. The salvage can only ever move a verdict
// from REVIEW to DENY — never to ALLOW — which is the property the self-test pins.
export function salvageDenied(raw, deniedSet, denyLiteralSet) {
  const tokens = raw.match(IDENTIFIER_RUN) ?? [];
  for (const token of tokens) {
    if (denyLiteralSet.has(token)) return token;
    const bare = token.endsWith('+') ? token.slice(0, -1) : token;
    if (deniedSet.has(canonicalLicence(bare, token.endsWith('+')))) return token;
  }
  return null;
}

// ── Classification ──────────────────────────────────────────────────────────────────────
// Stage order, and what each stage is for. Every stage below runs on the CANONICALISED string:
// identifiers are folded onto their registered SPDX spelling and deprecated single-identifier
// `WITH` forms are rewritten, so every stage after stage N sees one spelling per licence and an
// expression whose structure matches its meaning.
//
//   N. canonicalise        →        case-fold onto the registered SPDX spelling, then rewrite
//                                   deprecated `X-with-Y` → `X-only WITH Y-version` (7 ids)
//   0. denyByName          → DENY   (outside the licence pipeline entirely; see the caller)
//   1. denyLiteral         → DENY   exact string, on the string pnpm reported and on the
//                                   normalised one; `UNLICENSED` is not an SPDX identifier
//   2. satisfies(allow)    → ALLOW  before any deny check, so `(BSD OR GPL-2.0)` passes
//   3. parse failure       → DENY if a denied identifier is buried in it, else REVIEW
//   4. review exact match  → REVIEW
//   5. denied expression   → DENY   OR-aware, AND-aware, WITH-aware; deprecated ids included
//   6. anything else       → REVIEW unknown is not the same as safe
//
// Which stages are load-bearing, MEASURED rather than asserted — each stage was short-circuited
// in a copy of this file and `--self-test` re-run, on 2026-09-03 against the fixtures below:
//
//   stage N  →  11 failures      stage 3  →   3 failures
//   stage 1  →   3 failures      stage 4  →   0 failures   ← not load-bearing
//   stage 2  →  13 failures      stage 5  →  19 failures
//
// Stage 4 is the exception, and the honest description is that it is a documentation stage, not
// a verdict stage: `POLICY.review` holds no entry that stage 2 would allow and none that stage 5
// would deny, so every review entry falls through to stage 6 and comes out REVIEW anyway. It is
// kept because it makes the REVIEW list mean "reviewed and listed" rather than "fell through",
// and `reviewNeverShadowsDeny` is what keeps that substitution safe. If a `WITH` entry is ever
// added to `POLICY.review`, stage 4 starts carrying weight and that assertion is where the
// decision to let it gets recorded. Stage 6 is the fallthrough and cannot be deleted.

export function makePolicy(policy, scope) {
  const allow = scope === 'dev' ? policy.allow.concat(policy.allowDev ?? []) : policy.allow;
  return {
    scope,
    allowSet: canonicalSet(allow),
    reviewSet: new Set(policy.review),
    denySet: canonicalSet(policy.denyFamilies),
    denyLiteralSet: new Set(policy.denyLiteral),
    denyByName: policy.denyByName ?? [],
  };
}

export function classify(licence, compiled) {
  // Stage N. Every stage below reads `normalised`, not `licence`, with one exception: the two
  // exact-match policy lists are consulted under BOTH spellings, so a policy entry keeps
  // matching the string pnpm actually printed as well as its canonical SPDX form.
  const normalised = canonicaliseSpdx(licence);
  if (compiled.denyLiteralSet.has(licence) || compiled.denyLiteralSet.has(normalised)) {
    return { verdict: 'deny', why: 'denyLiteral: not an open-source licence this project accepts' };
  }
  let ast;
  try {
    ast = parseSpdx(normalised);
  } catch (error) {
    // The offset in `error.message` is an offset into `normalised`, so say so when that is not
    // the string pnpm printed. Silently reporting an offset into a string the reader cannot
    // see is the kind of small lie this file has had too many of.
    const where = normalised === licence ? error.message : `${error.message}, in \`${normalised}\``;
    const buried = salvageDenied(normalised, compiled.denySet, compiled.denyLiteralSet);
    if (buried) {
      return {
        verdict: 'deny',
        why: `unparseable SPDX expression containing \`${buried}\` (${where})`,
      };
    }
    return { verdict: 'review', why: `unparseable SPDX expression (${where})` };
  }
  if (expressionSatisfies(ast, compiled.allowSet)) {
    return { verdict: 'allow', why: 'on the allow list' };
  }
  if (compiled.reviewSet.has(licence) || compiled.reviewSet.has(normalised)) {
    return { verdict: 'review', why: 'on the review list' };
  }
  if (expressionDenied(ast, compiled.denySet)) {
    return { verdict: 'deny', why: 'strong copyleft: obliges compliance with a denied licence' };
  }
  return { verdict: 'review', why: 'on none of the policy lists' };
}

// ── Package names and exceptions ────────────────────────────────────────────────────────

export function matchName(patterns, name) {
  return patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : p === name));
}

// R-16 residual finding 6: the reference implementation keyed on the package NAME alone, so
// the `licence` field every exception carries was never compared. An exception recorded for
// `caniuse-lite` at CC-BY-4.0 would have cleared caniuse-lite under any other licence — a gate
// that can pass what it should stop. `matchException` now takes the licence and returns the
// entry only when the entry was granted for that exact licence string.
export function matchException(exceptions, name, licence) {
  for (const [pattern, entry] of Object.entries(exceptions)) {
    const nameMatches = pattern.endsWith('*')
      ? name.startsWith(pattern.slice(0, -1))
      : pattern === name;
    if (!nameMatches) continue;
    const granted = Array.isArray(entry.licence) ? entry.licence : [entry.licence];
    if (granted.includes(licence)) return { pattern, entry };
    return { pattern, entry, licenceMismatch: granted.join(' | ') };
  }
  return null;
}

// ── Whole-inventory evaluation ──────────────────────────────────────────────────────────
// `inventory` is the parsed output of `pnpm licenses list --json -r`: an object keyed by the
// declared licence string, each value an array of { name, versions[], paths[], … }. "Unknown"
// is the literal key pnpm emits for a licence it cannot resolve — it is where the proprietary
// Agent SDK hides, and it must never pass silently.

export function evaluateInventory(
  inventory,
  { policy = POLICY, exceptions = EXCEPTIONS, scope = 'prod', now = Date.now() } = {},
) {
  const compiled = makePolicy(policy, scope);
  const rows = [];
  for (const [licence, packages] of Object.entries(inventory)) {
    const { verdict, why } = classify(licence, compiled);
    for (const pkg of packages) {
      const version = Array.isArray(pkg.versions)
        ? pkg.versions.join(',')
        : String(pkg.versions ?? '');
      const row = { name: pkg.name, version, licence, verdict, why };

      // Stage 0. Checked first, independently of the licence verdict, and before the
      // exception lookup: every name on this list is MIT or Apache-2.0, so stages 1-6 would
      // return `allow` and skip it.
      if (matchName(compiled.denyByName, pkg.name)) {
        rows.push({
          ...row,
          verdict: 'deny',
          why: 'denyByName: a third-party sandbox vendor SDK, forbidden while D-09 stands',
        });
        continue;
      }
      if (verdict === 'allow') continue;

      const found = matchException(exceptions, pkg.name, licence);
      if (found && verdict !== 'deny') {
        const { pattern, entry, licenceMismatch } = found;
        if (licenceMismatch) {
          rows.push({
            ...row,
            why: `exception \`${pattern}\` was granted for ${licenceMismatch}, not for ${licence}; re-review`,
          });
        } else if (entry.scope !== scope && entry.scope !== 'all') {
          rows.push({
            ...row,
            why: `exception \`${pattern}\` is scoped '${entry.scope}', this run is '${scope}'`,
          });
        } else if (
          typeof entry.expires !== 'string' ||
          !Number.isFinite(Date.parse(entry.expires))
        ) {
          // An expiry the gate cannot read is not an expiry. `Date.parse` returns NaN for a
          // missing, empty or unrecognised value, and `NaN < now` is false — so the previous
          // `Date.parse(entry.expires) < now` fell straight through to "cleared by the
          // exception" and granted that package a permanent pass. An absent expiry has to fail
          // closed: it is the difference between an exception and a policy change. The
          // self-test asserts the shipped register carries five fields on every entry, but
          // that assertion covers the register in this file, not one passed in by a caller or
          // edited to `expires: 'soon'`, so the check belongs here too.
          //
          // The `typeof` half is not belt-and-braces. `Date.parse` coerces its argument to a
          // string first, so `expires: 90` parses — as the year 1990 — and reports "expired 90"
          // rather than an unreadable date. A date this register can be reasoned about is an
          // ISO-8601 string, and anything else is a mistake worth naming as one.
          rows.push({
            ...row,
            why: `exception \`${pattern}\` has an unreadable expiry (${JSON.stringify(entry.expires ?? null)}); an exception without a usable expiry clears nothing`,
          });
        } else if (Date.parse(entry.expires) < now) {
          rows.push({
            ...row,
            why: `exception \`${pattern}\` expired ${entry.expires}; re-review or renew`,
          });
        }
        continue; // Cleared by the exception.
      }
      rows.push(row);
    }
  }
  rows.sort(
    (a, b) =>
      (a.verdict === b.verdict ? 0 : a.verdict === 'deny' ? -1 : 1) || a.name.localeCompare(b.name),
  );
  return rows;
}

// ── Reporting ───────────────────────────────────────────────────────────────────────────

function renderTable(rows) {
  const header = ['VERDICT', 'PACKAGE', 'LICENCE', 'WHY'];
  const body = rows.map((r) => [
    r.verdict.toUpperCase(),
    `${r.name}@${r.version}`,
    r.licence,
    r.why,
  ]);
  const widths = header.map((h, i) =>
    Math.min(60, Math.max(h.length, ...body.map((row) => row[i].length))),
  );
  const line = (cells) =>
    '  ' + cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join('  ');
  return [line(header), line(widths.map((w) => '─'.repeat(w))), ...body.map(line)].join('\n');
}

// ── Modes ───────────────────────────────────────────────────────────────────────────────

/** An engine id as `ENGINE_IDS` spells one; the only input this script interpolates. */
const ENGINE_ID = /^[a-z][a-z0-9-]*$/u;

function readInventory(scope, engine) {
  // execSync, not execFileSync: Node 24 refuses to spawn `pnpm.cmd` without a shell (EINVAL),
  // and passing an args array WITH a shell emits DEP0190. The command is a fixed literal apart
  // from an engine id that `main` has already held to ENGINE_ID, so a shell is safe here.
  // Probed on Windows 11 / Node 24.19.0.
  const command =
    engine === undefined
      ? `pnpm licenses list ${scope === 'dev' ? '--dev' : '--prod'} --json -r`
      : `pnpm --filter "@agent-workspace/runner..." --filter "@agent-workspace/engine-${engine}..." licenses list --prod --json`;
  let raw;
  try {
    raw = execSync(command, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch {
    console.error(`\nLicence policy: FAIL — \`${command}\` did not run.`);
    console.error(
      'Run `pnpm install --frozen-lockfile` first; the gate inspects the installed tree.',
    );
    return null;
  }
  // `pnpm licenses list` exits 0 whatever it finds — it is an inventory command, not a gate.
  // The gate is this script's exit code. An empty tree prints nothing at all.
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    console.error(`\nLicence policy: FAIL — could not parse the output of \`${command}\`.`);
    return null;
  }
}

function gateMode(scope, engine) {
  const inventory = readInventory(scope, engine);
  if (inventory === null) return 1;
  const rows = evaluateInventory(inventory, { scope });
  const denied = rows.filter((r) => r.verdict === 'deny');
  const review = rows.filter((r) => r.verdict === 'review');

  if (rows.length) {
    console.error(`\nLicence policy (${scope}) — packages that are not on the allow list:\n`);
    console.error(renderTable(rows));
    console.error('');
    if (denied.length) {
      console.error(
        'DENY cannot be cleared by an exception. Remove the dependency, or change the policy in',
      );
      console.error('scripts/check-licenses.mjs with an ADR saying why.');
    }
    if (review.length) {
      console.error(
        'REVIEW needs a recorded exception in the register at the top of scripts/check-licenses.mjs,',
      );
      console.error('with a reviewer, a reason, the exact licence string, and an expiry.');
    }
    console.error(
      `\nLicence policy: FAIL (${denied.length} denied, ${review.length} to review) [${scope}].`,
    );
    console.error('See docs/dependency-policy.md.');
    return 1;
  }
  console.log(`Licence policy: PASS (${scope}).`);
  return 0;
}

// ── Self-test ───────────────────────────────────────────────────────────────────────────
// Every fixture below is either a case R-16 probed live (and so pins this implementation to
// that note's recorded behaviour) or one of the six residual findings ADR-0005 routed to this
// task. Three of the six were contract defects and are closed here in code; the other three
// (N1, N2, N5) were corrections to the note's own prose and are closed in
// the licensing research note (maintained privately).
//
// The three code fixtures are labelled `R-16 residual 1`, `2` and `3`, and those numbers are
// FIXTURE labels, not R-16's finding numbers. R-16's own residual table gives the mapping:
// N4 → "R-16 residual 1", N6 → "R-16 residual 2", N3 → "R-16 residual 3".

// SPDX License List 3.28.0 (released 2026-02-20), fetched from
// https://raw.githubusercontent.com/spdx/license-list-data/v3.28.0/json/licenses.json on
// 2026-09-03 and reduced to the identifiers this policy uses. All 30 were present and none was
// flagged `isDeprecatedLicenseId`. `UNLICENSED` was absent, which is why it is `denyLiteral`.
const SPDX_3_28_0_IDENTIFIERS_USED_BY_THIS_POLICY = [
  'MIT',
  'MIT-0',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Python-2.0',
  'PostgreSQL',
  'MPL-2.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'EPL-2.0',
  'CDDL-1.0',
  'LGPL-2.1-or-later',
  'LGPL-3.0-or-later',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'SSPL-1.0',
  'BUSL-1.1',
  'Elastic-2.0',
  'CC-BY-NC-4.0',
  'CC-BY-SA-4.0',
];

// Every identifier the policy mentions, flattened. `UNLICENSED` is excluded by name because it
// is the one string here that is deliberately not an SPDX identifier.
function policyIdentifiers(policy) {
  const out = new Set();
  for (const key of ['allow', 'allowDev', 'review', 'denyFamilies', 'denyLiteral']) {
    for (const entry of policy[key] ?? []) {
      if (entry === 'UNLICENSED') continue;
      for (const token of entry.split(/\s+(?:AND|OR|WITH)\s+/)) out.add(token);
    }
  }
  return [...out];
}

function selfTest() {
  let failed = 0;
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok)
      console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  // Read one field of one row of an evaluator result WITHOUT assuming the result has that row.
  // Three mutants were built to check that this self-test kills the exception-lifecycle
  // invariants (name-only `matchException`, expiry check removed, scope check removed). Each
  // makes `evaluateInventory` return fewer rows than the fixture expects, and `rows[0].why` on
  // an empty array throws `TypeError:
  // Cannot read properties of undefined (reading 'why')` — a non-zero exit that blocks CI while
  // telling the next maintainer nothing about which invariant broke, and, for the scope mutant,
  // after printing no FAIL line at all. Returning a describing string instead means the
  // assertion below fails by name, and prints what it actually got.
  const field = (rows, key, index = 0) => {
    if (!Array.isArray(rows)) return `<evaluateInventory returned ${typeof rows}, not an array>`;
    if (rows.length <= index)
      return `<no row ${index}: evaluateInventory returned ${rows.length} row(s), so nothing was reported for this package>`;
    const value = rows[index][key];
    return value === undefined ? `<row ${index} has no \`${key}\` field>` : value;
  };
  // `check` compares with JSON.stringify, which turns every miss on a substring assertion into
  // `expected true, got false` and throws away the string that would explain it. This one keeps
  // it, so a FAIL line is followed by the text that was actually produced.
  const checkContains = (name, actual, needle) => {
    const ok = typeof actual === 'string' && actual.includes(needle);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok)
      console.log(
        `        expected a string containing ${JSON.stringify(needle)}, got ${JSON.stringify(actual)}`,
      );
  };
  const prod = makePolicy(POLICY, 'prod');
  const dev = makePolicy(POLICY, 'dev');
  const v = (licence, compiled = prod) => classify(licence, compiled).verdict;
  const parses = (s) => {
    try {
      parseSpdx(s);
      return true;
    } catch {
      return false;
    }
  };

  console.log('SPDX expression parser');
  check('a bare identifier parses', parses('MIT'), true);
  check('a parenthesised disjunction parses', parses('(BSD-3-Clause OR GPL-2.0)'), true);
  check('an unparenthesised disjunction parses', parses('MIT OR Unlicense'), true);
  check('a conjunction parses', parses('Apache-2.0 AND LGPL-3.0-or-later'), true);
  check('a three-way conjunction parses', parses('Apache-2.0 AND LGPL-3.0-or-later AND MIT'), true);
  check('WITH parses', parses('Apache-2.0 WITH LLVM-exception'), true);
  check('the `+` suffix parses', parses('GPL-3.0+'), true);
  check('a LicenseRef parses', parses('LicenseRef-Anthropic-Commercial'), true);
  check(
    'an OCI-style aggregate parses',
    parses('Apache-2.0 AND LicenseRef-Anthropic-Commercial'),
    true,
  );
  check('"SEE LICENSE IN README.md" does not parse', parses('SEE LICENSE IN README.md'), false);
  check('a glob does not parse', parses('BSD*'), false);
  check('an unbalanced paren does not parse', parses('(MIT'), false);
  check('a dangling operator does not parse', parses('MIT AND'), false);
  check('an empty string does not parse', parses(''), false);
  check(
    'the parse error names the offending character and offset',
    (() => {
      try {
        parseSpdx('GPL-2.0-only WITH <OpenSSL exception>');
        return 'did not throw';
      } catch (e) {
        return e.message;
      }
    })(),
    'Unexpected `<` at offset 18',
  );

  console.log('\nprecedence — AND binds tighter than OR');
  // Both cases below come out ALLOW under the SPDX precedence (`AND` binds tighter than `OR`,
  // so we may take the bare MIT disjunct) and DENY if the two operators are read left to right.
  // A parser that got the precedence backwards would fail the build on a licence we accept.
  check('AND/OR precedence, MIT on the left', v('MIT OR GPL-3.0-only AND GPL-2.0-only'), 'allow');
  check('AND/OR precedence, MIT on the right', v('GPL-2.0-only AND MIT OR MIT'), 'allow');

  console.log('\ncanonical identifiers — the deprecated GNU forms R-16 F10 defect 1 is about');
  check('GPL-3.0 canonicalises to GPL-3.0-only', canonicalLicence('GPL-3.0'), 'GPL-3.0-only');
  check(
    'GPL-3.0+ canonicalises to GPL-3.0-or-later',
    canonicalLicence('GPL-3.0', true),
    'GPL-3.0-or-later',
  );
  check('AGPL-3.0 canonicalises', canonicalLicence('AGPL-3.0'), 'AGPL-3.0-only');
  check('LGPL-3.0 canonicalises', canonicalLicence('LGPL-3.0'), 'LGPL-3.0-only');
  check('a current identifier is unchanged', canonicalLicence('GPL-3.0-only'), 'GPL-3.0-only');
  check('a non-GNU identifier is unchanged', canonicalLicence('Apache-2.0'), 'Apache-2.0');
  check(
    'canonicalLicence no longer invents a WITH expansion of its own',
    canonicalLicence('GPL-2.0-with-classpath-exception'),
    'GPL-2.0-with-classpath-exception',
  );

  console.log('\ndeprecated single-identifier WITH forms — the laundering path this closes');
  // Seven identifiers, and every one of them classified REVIEW before this. A REVIEW is
  // clearable by a recorded exception, so each was a way to put GPL into the tree and clear it
  // with a two-line register entry. The cause was structural: the deprecated form is ONE token,
  // so it parsed into a `lic` node, and `expressionDenied`'s `with` branch — the branch that
  // decides a `WITH` on its base — was never reached; the whole expanded string was looked up
  // in `denySet`, where it is not. Normalising to the current SPDX spelling before classifying
  // makes the node a real `with` node, and the base is `GPL-N.0-only`, which is DENY.
  const deprecatedWithForms = Object.keys(DEPRECATED_SPDX_WITH_FORMS);
  check(
    'the map holds exactly the seven deprecated WITH ids on SPDX 3.28.0',
    deprecatedWithForms.slice().sort(),
    [
      'GPL-2.0-with-GCC-exception',
      'GPL-2.0-with-autoconf-exception',
      'GPL-2.0-with-bison-exception',
      'GPL-2.0-with-classpath-exception',
      'GPL-2.0-with-font-exception',
      'GPL-3.0-with-GCC-exception',
      'GPL-3.0-with-autoconf-exception',
    ].sort(),
  );
  check(
    'each normalises to the replacement SPDX itself documents',
    deprecatedWithForms.map((id) => `${id} → ${canonicaliseSpdx(id)}`),
    [
      'GPL-2.0-with-autoconf-exception → GPL-2.0-only WITH Autoconf-exception-2.0',
      'GPL-2.0-with-bison-exception → GPL-2.0-only WITH Bison-exception-2.2',
      'GPL-2.0-with-classpath-exception → GPL-2.0-only WITH Classpath-exception-2.0',
      'GPL-2.0-with-font-exception → GPL-2.0-only WITH Font-exception-2.0',
      'GPL-2.0-with-GCC-exception → GPL-2.0-only WITH GCC-exception-2.0',
      'GPL-3.0-with-autoconf-exception → GPL-3.0-only WITH Autoconf-exception-3.0',
      'GPL-3.0-with-GCC-exception → GPL-3.0-only WITH GCC-exception-3.1',
    ],
  );
  check(
    'every replacement parses as an SPDX expression',
    deprecatedWithForms.filter((id) => !parses(DEPRECATED_SPDX_WITH_FORMS[id])),
    [],
  );
  // The verdict, one fixture per identifier, named so a regression says which one came back.
  for (const id of deprecatedWithForms) check(`${id} is DENY`, v(id), 'deny');
  check(
    'and none of the seven is REVIEW, which an exception could clear',
    deprecatedWithForms.filter((id) => v(id) !== 'deny'),
    [],
  );
  check(
    'no exception can clear one of them either',
    evaluateInventory(
      { 'GPL-2.0-with-classpath-exception': [{ name: 'some-jdk-binding', versions: ['1.0.0'] }] },
      {
        exceptions: {
          'some-jdk-binding': {
            licence: 'GPL-2.0-with-classpath-exception',
            scope: 'prod',
            reviewer: 'x',
            reason: 'y',
            expires: '2999-01-01',
          },
        },
        scope: 'prod',
      },
    ).map((r) => `${r.verdict}:${r.name}`),
    ['deny:some-jdk-binding'],
  );
  // The same normalisation runs before the salvage scan, so a deprecated identifier buried in a
  // string that does not parse is caught too.
  checkContains(
    'a deprecated WITH form inside an unparseable string is DENY',
    classify('GPL-2.0-with-classpath-exception <vendor note>', prod).why,
    '`GPL-2.0-only`',
  );
  // A `-with-` spelling that is on no SPDX list at all — a typo, or a future deprecation this
  // map has not been updated for. It is still a GPL base wearing a tail, so it still denies.
  check(
    'an unrecognised GNU -with- spelling is DENY too',
    v('GPL-3.0-with-made-up-exception'),
    'deny',
  );
  check(
    'a current WITH expression is untouched by canonicalisation',
    canonicaliseSpdx('Apache-2.0 WITH LLVM-exception'),
    'Apache-2.0 WITH LLVM-exception',
  );
  check(
    'and a non-GNU identifier that merely contains "with" is untouched',
    canonicaliseSpdx('MIT AND BSD-3-Clause'),
    'MIT AND BSD-3-Clause',
  );

  console.log('\ncase — SPDX identifiers are case-insensitive, so every spelling is one licence');
  // Door three, and the fourth instance of one defect: a verdict reachable by a spelling nobody
  // tried. Matching was case-sensitive throughout, so `gpl-2.0-with-classpath-exception` and
  // `GPL-2.0-WITH-CLASSPATH-EXCEPTION` came out REVIEW — clearable by a two-line register entry
  // — where the canonically-cased spelling came out DENY. The fix is one canonicalisation at the
  // boundary, not a case-insensitive compare at each of the eight comparison sites, so these
  // fixtures assert the OUTCOME at `classify`, which is what a future site would have to keep.
  const denyAnyCase = [
    'gpl-2.0-with-classpath-exception',
    'GPL-2.0-WITH-CLASSPATH-EXCEPTION',
    'GPL-2.0-With-Classpath-Exception',
    'gpl-3.0-with-gcc-exception',
    'GPL-3.0-WITH-AUTOCONF-EXCEPTION',
    'gpl-2.0-with-BISON-exception',
    'gpl-3.0',
    'AGPL-3.0-ONLY',
    'gpl-3.0+',
    'unlicensed',
    'sspl-1.0',
  ];
  for (const id of denyAnyCase) check(`${id} is DENY whatever its case`, v(id), 'deny');
  check(
    'and not one of them is REVIEW, which an exception could clear',
    denyAnyCase.filter((id) => v(id) !== 'deny'),
    [],
  );
  check(
    'no exception clears a lower-cased deprecated WITH form either',
    evaluateInventory(
      { 'gpl-2.0-with-classpath-exception': [{ name: 'some-jdk-binding', versions: ['1.0.0'] }] },
      {
        exceptions: {
          'some-jdk-binding': {
            licence: 'gpl-2.0-with-classpath-exception',
            scope: 'prod',
            reviewer: 'x',
            reason: 'y',
            expires: '2999-01-01',
          },
        },
        scope: 'prod',
      },
    ).map((r) => `${r.verdict}:${r.name}`),
    ['deny:some-jdk-binding'],
  );
  // An invented `-with-` tail in upper case: `GPL-3.0-WITH-...` is ONE token, so the `WITH`
  // inside it is not an operator and the case-sensitive `-with-` rule walked straight past it.
  check(
    'an invented GNU -with- spelling denies in upper case too',
    v('GPL-3.0-WITH-MADE-UP-EXCEPTION'),
    'deny',
  );
  // The other direction, which matters just as much: canonicalisation must not OVER-REACH.
  // An allowed licence in any case is still allowed, and a string that merely looks like one
  // must stay unknown rather than be massaged into a decidable verdict.
  for (const id of ['mit', 'MiT', 'apache-2.0', 'APACHE-2.0', 'bsd-3-clause', 'iSC'])
    check(`${id} is ALLOW whatever its case`, v(id), 'allow');
  check('MITTENS is not MIT', v('MITTENS'), 'review');
  check('Apache-2.1 is not Apache-2.0', v('Apache-2.1'), 'review');
  check('an unknown licence stays unknown', v('Unknown'), 'review');
  // Operator case is deliberately NOT folded. SPDX operators are upper-case; folding `or` up to
  // `OR` would turn an invalid expression into a valid one and could only ever loosen a verdict
  // — `GPL-3.0 or MIT` is unparseable and denied by the salvage scan, whereas
  // `GPL-3.0-only OR MIT` would be ALLOW. This fixture is what stops a later "tidy-up".
  check('a lower-case operator is not folded into a valid expression', v('gpl-3.0 or mit'), 'deny');
  check(
    'and the identifiers inside it were still canonicalised',
    canonicaliseSpdx('gpl-3.0 or mit'),
    'GPL-3.0 or MIT',
  );
  check(
    'AND / OR / WITH keep their own case',
    canonicaliseSpdx('mit AND apache-2.0 OR bsd-3-clause'),
    'MIT AND Apache-2.0 OR BSD-3-Clause',
  );
  // The registry is a positive assertion — "this token IS identifier X" — and it can only hold
  // one spelling per licence. Two entries differing by case would make canonicalisation
  // ambiguous, so the build throws; this pins that the shipped policy does not trip it.
  check(
    'the spelling registry builds without a case collision',
    (() => {
      try {
        return canonicaliseSpdx('MIT') === 'MIT' ? 'built' : 'wrong';
      } catch (error) {
        return `threw: ${error.message}`;
      }
    })(),
    'built',
  );

  console.log('\nclassification — every row of R-16 C.1’s verified table');
  check('MIT', v('MIT'), 'allow');
  check('Apache-2.0', v('Apache-2.0'), 'allow');
  check('MIT OR Unlicense', v('MIT OR Unlicense'), 'allow');
  check(
    '(BSD-3-Clause OR GPL-2.0) — node-forge; OR is a choice',
    v('(BSD-3-Clause OR GPL-2.0)'),
    'allow',
  );
  check('GPL-3.0 — deprecated id', v('GPL-3.0'), 'deny');
  check('GPL-3.0+ — deprecated id', v('GPL-3.0+'), 'deny');
  check('AGPL-3.0 — deprecated id', v('AGPL-3.0'), 'deny');
  check('GPL-2.0 — deprecated id', v('GPL-2.0'), 'deny');
  check('GPL-3.0-only', v('GPL-3.0-only'), 'deny');
  check('AGPL-3.0-only', v('AGPL-3.0-only'), 'deny');
  check('SSPL-1.0 — denyLiteral', v('SSPL-1.0'), 'deny');
  check('BUSL-1.1 — denyLiteral', v('BUSL-1.1'), 'deny');
  check('UNLICENSED — denyLiteral, and not an SPDX id', v('UNLICENSED'), 'deny');
  check('LGPL-3.0-or-later — libvips', v('LGPL-3.0-or-later'), 'review');
  check('LGPL-3.0 — deprecated, still REVIEW not DENY', v('LGPL-3.0'), 'review');
  check(
    'Apache-2.0 AND LGPL-3.0-or-later — sharp on win32',
    v('Apache-2.0 AND LGPL-3.0-or-later'),
    'review',
  );
  check('MPL-2.0 in prod', v('MPL-2.0'), 'review');
  check('MPL-2.0 in dev', v('MPL-2.0', dev), 'allow');
  check('CC-BY-4.0 in prod', v('CC-BY-4.0'), 'review');
  check('CC-BY-4.0 in dev', v('CC-BY-4.0', dev), 'allow');
  check('(MIT AND CC-BY-3.0) in prod', v('(MIT AND CC-BY-3.0)'), 'review');
  check('(MIT AND CC-BY-3.0) in dev', v('(MIT AND CC-BY-3.0)', dev), 'allow');
  check(
    'Apache-2.0 WITH LLVM-exception — base+exception is not the base',
    v('Apache-2.0 WITH LLVM-exception'),
    'review',
  );
  check('Unknown — pnpm’s literal key for an unresolvable licence', v('Unknown'), 'review');
  check('SEE LICENSE IN README.md — the Agent SDK', v('SEE LICENSE IN README.md'), 'review');
  check('BSD* — a legacy npm glob', v('BSD*'), 'review');
  check('a LicenseRef falls through to REVIEW', v('LicenseRef-Anthropic-Commercial'), 'review');

  console.log('\nR-16 residual 1 — `GPL-2.0-only WITH <OpenSSL exception>`');
  // The string is not a policy input: it is R-16 F6's SPDX column for socat, an OS-level
  // component the npm gate never sees. But a string of this shape MUST NOT be able to reach
  // REVIEW, where an exception could clear it, merely because it fails to parse. See
  // docs/adr/W0-INF-03-unparseable-spdx-expressions.md.
  check('the socat string is DENY, not REVIEW', v('GPL-2.0-only WITH <OpenSSL exception>'), 'deny');
  check(
    'and the reason names the buried identifier',
    classify('GPL-2.0-only WITH <OpenSSL exception>', prod).why.includes('`GPL-2.0-only`'),
    true,
  );
  check(
    'a valid SPDX exception on a GPL base is also DENY',
    v('GPL-2.0-only WITH Classpath-exception-2.0'),
    'deny',
  );
  check(
    'salvage does not fire on a benign unparseable string',
    v('SEE LICENSE IN README.md'),
    'review',
  );
  check('salvage does not fire on "Unknown"', v('Unknown'), 'review');
  check(
    'salvage can never produce ALLOW',
    [
      'SEE LICENSE IN README.md',
      'Unknown',
      'BSD*',
      'GPL-2.0-only WITH <OpenSSL exception>',
      'AGPL-3.0 or something',
    ]
      .map((s) => v(s))
      .filter((verdict) => verdict === 'allow'),
    [],
  );

  console.log('\nR-16 residual 2 — matchException must compare the licence, not just the name');
  const reg = {
    'caniuse-lite': {
      licence: 'CC-BY-4.0',
      scope: 'prod',
      reviewer: 'x',
      reason: 'y',
      expires: '2999-01-01',
    },
    '@img/sharp-libvips-*': {
      licence: 'LGPL-3.0-or-later',
      scope: 'prod',
      reviewer: 'x',
      reason: 'y',
      expires: '2999-01-01',
    },
  };
  check(
    'an exception matches the licence it was granted for',
    matchException(reg, 'caniuse-lite', 'CC-BY-4.0')?.licenceMismatch ?? 'matched',
    'matched',
  );
  check(
    'and does NOT match a different licence',
    matchException(reg, 'caniuse-lite', 'MPL-2.0')?.licenceMismatch,
    'CC-BY-4.0',
  );
  check(
    'a wildcard entry still matches on name',
    matchException(reg, '@img/sharp-libvips-linux-x64', 'LGPL-3.0-or-later')?.pattern,
    '@img/sharp-libvips-*',
  );
  check('an unlisted package matches nothing', matchException(reg, 'left-pad', 'MIT'), null);
  // The end-to-end form of the same finding: on the OLD name-only behaviour this inventory
  // passed. It must now fail.
  const relicensed = evaluateInventory(
    { 'MPL-2.0': [{ name: 'caniuse-lite', versions: ['1.0.30001810'] }] },
    { exceptions: reg, scope: 'prod' },
  );
  check('a relicensed package is no longer cleared by its old exception', relicensed.length, 1);
  checkContains('and the row says why', field(relicensed, 'why'), 'was granted for CC-BY-4.0');

  console.log('\nR-16 residual 3 — all 30 identifiers exist on SPDX 3.28.0');
  const used = policyIdentifiers(POLICY).sort();
  const known = new Set(SPDX_3_28_0_IDENTIFIERS_USED_BY_THIS_POLICY);
  check('the policy uses 30 SPDX identifiers, not 16', used.length, 30);
  check(
    'every one of them is on the verified 3.28.0 list',
    used.filter((id) => !known.has(id)),
    [],
  );
  check('UNLICENSED is not among them', used.includes('UNLICENSED'), false);
  check(
    'UNLICENSED is on denyLiteral, where a non-SPDX string belongs',
    POLICY.denyLiteral.includes('UNLICENSED'),
    true,
  );

  console.log('\npolicy invariants');
  // Stage 4 (`review`) runs before stage 5 (the deny families), which is only safe while no
  // review entry would be denied. If you deliberately want a reviewable GPL-with-exception
  // string, this assertion is the place to record that decision — and docs/dependency-policy.md
  // is where to explain it.
  check(
    'reviewNeverShadowsDeny — no review entry is a denied expression',
    POLICY.review.filter((entry) => {
      try {
        return expressionDenied(parseSpdx(entry), prod.denySet);
      } catch {
        return true;
      }
    }),
    [],
  );
  check(
    'every allow entry parses and is not denied',
    POLICY.allow.concat(POLICY.allowDev).filter((entry) => {
      try {
        return expressionDenied(parseSpdx(entry), prod.denySet);
      } catch {
        return true;
      }
    }),
    [],
  );
  check(
    'every exception carries a licence, a scope, a reviewer, a reason and an expiry',
    Object.entries(EXCEPTIONS)
      .filter(([, e]) => !e.licence || !e.scope || !e.reviewer || !e.reason || !e.expires)
      .map(([k]) => k),
    [],
  );
  check(
    'every exception is for a licence the classifier does not already allow',
    Object.entries(EXCEPTIONS)
      .filter(([, e]) => {
        const granted = Array.isArray(e.licence) ? e.licence : [e.licence];
        return granted.some((l) => classify(l, prod).verdict === 'allow');
      })
      .map(([k]) => k),
    [],
  );
  check(
    'no exception tries to clear a DENY',
    Object.entries(EXCEPTIONS)
      .filter(([, e]) => {
        const granted = Array.isArray(e.licence) ? e.licence : [e.licence];
        return granted.some((l) => classify(l, prod).verdict === 'deny');
      })
      .map(([k]) => k),
    [],
  );

  console.log('\ndenyByName — spec A.9 / D-09, the stage a licence gate cannot express');
  check('e2b is denied by name', matchName(POLICY.denyByName, 'e2b'), true);
  check(
    'a scoped vendor package is denied by name',
    matchName(POLICY.denyByName, '@vercel/sandbox'),
    true,
  );
  check('a lookalike is not', matchName(POLICY.denyByName, 'e2b-utils'), false);
  check('an unrelated package is not', matchName(POLICY.denyByName, 'next'), false);
  const vendor = evaluateInventory(
    {
      MIT: [
        { name: 'e2b', versions: ['2.46.1'] },
        { name: 'next', versions: ['16.3.4'] },
      ],
      'Apache-2.0': [{ name: '@vercel/sandbox', versions: ['3.2.1'] }],
    },
    { scope: 'prod' },
  );
  check(
    'a permissively licensed vendor SDK is still denied',
    vendor.map((r) => `${r.name}:${r.verdict}`),
    ['@vercel/sandbox:deny', 'e2b:deny'],
  );

  console.log('\nend to end — the W0-INF-03 acceptance criterion (plan §6.2)');
  // "A GPL dependency introduced in a test branch fails CI." R-16 F10 RUN 4 demonstrated this
  // live with `pnpm add ccnetviz`, which declares the DEPRECATED identifier `GPL-3.0`; that
  // exact inventory shape is the fixture here so the criterion is checked on every CI run and
  // not only when someone remembers to install a GPL package.
  const gplTree = {
    MIT: [{ name: 'next', versions: ['16.3.4'] }],
    'GPL-3.0': [{ name: 'ccnetviz', versions: ['1.0.19'] }],
    Unknown: [{ name: 'taffydb', versions: ['2.6.2'] }],
  };
  const gplRows = evaluateInventory(gplTree, { scope: 'prod' });
  check(
    'a GPL dependency is reported',
    gplRows.map((r) => `${r.verdict}:${r.name}`),
    ['deny:ccnetviz', 'review:taffydb'],
  );
  check(
    'and no exception can clear it',
    evaluateInventory(gplTree, {
      exceptions: {
        ccnetviz: {
          licence: 'GPL-3.0',
          scope: 'prod',
          reviewer: 'x',
          reason: 'y',
          expires: '2999-01-01',
        },
      },
      scope: 'prod',
    }).some((r) => r.name === 'ccnetviz' && r.verdict === 'deny'),
    true,
  );
  check(
    'a clean prod tree produces no rows at all',
    evaluateInventory({ MIT: [{ name: 'next', versions: ['16.3.4'] }] }, { scope: 'prod' }),
    [],
  );

  console.log('\nexception lifecycle');
  const sdkTree = {
    Unknown: [
      { name: '@anthropic-ai/claude-agent-sdk', versions: ['0.3.258'] },
      { name: '@anthropic-ai/claude-agent-sdk-win32-x64', versions: ['0.3.258'] },
    ],
    'CC-BY-4.0': [{ name: 'caniuse-lite', versions: ['1.0.30001810'] }],
    'Apache-2.0 AND LGPL-3.0-or-later': [{ name: '@img/sharp-win32-x64', versions: ['0.35.4'] }],
    'LGPL-3.0-or-later': [{ name: '@img/sharp-libvips-linux-x64', versions: ['1.3.3'] }],
  };
  const beforeExpiry = Date.parse('2026-09-03');
  const afterExpiry = Date.parse('2027-01-01');
  check(
    'the shipped register clears the real prod tree',
    evaluateInventory(sdkTree, { scope: 'prod', now: beforeExpiry }),
    [],
  );
  check(
    'and every one of them fails once the expiry passes',
    evaluateInventory(sdkTree, { scope: 'prod', now: afterExpiry }).length,
    5,
  );
  checkContains(
    'an expired exception says so',
    field(evaluateInventory(sdkTree, { scope: 'prod', now: afterExpiry }), 'why'),
    'expired 2026-12-02',
  );
  // An exception whose `expires` the gate cannot read used to clear its package FOREVER.
  // `Date.parse` returns NaN for a missing, empty or unrecognised value, and `NaN < now` is
  // false, so the expiry branch was skipped and control fell through to `continue // Cleared by
  // the exception`. The register in this file is protected by the five-fields assertion in
  // `policy invariants` above, but that assertion sees only this file's register: an exception
  // typed `expires: 'soon'`, or one supplied by a caller, went straight through. An absent
  // expiry now fails closed.
  const noExpiryTree = {
    'LGPL-3.0-or-later': [{ name: '@img/sharp-libvips-linux-x64', versions: ['1.3.3'] }],
  };
  const withoutExpiry = (expires) => ({
    '@img/sharp-libvips-*': {
      licence: 'LGPL-3.0-or-later',
      scope: 'prod',
      reviewer: 'x',
      reason: 'y',
      ...(expires === undefined ? {} : { expires }),
    },
  });
  for (const [label, expires] of [
    ['missing', undefined],
    ['empty', ''],
    ['unparseable', 'soon'],
    ['null', null],
    ['a number of days', 90],
  ]) {
    checkContains(
      `an exception whose expiry is ${label} does not clear anything`,
      field(
        evaluateInventory(noExpiryTree, {
          exceptions: withoutExpiry(expires),
          scope: 'prod',
          now: beforeExpiry,
        }),
        'why',
      ),
      'unreadable expiry',
    );
  }
  check(
    'a readable expiry in the future still clears',
    evaluateInventory(noExpiryTree, {
      exceptions: withoutExpiry('2999-01-01'),
      scope: 'prod',
      now: beforeExpiry,
    }),
    [],
  );
  checkContains(
    'a prod-scoped exception does not clear a dev run',
    field(
      evaluateInventory(
        { 'LGPL-3.0-or-later': [{ name: '@img/sharp-libvips-linux-x64', versions: ['1.3.3'] }] },
        { scope: 'dev', now: beforeExpiry },
      ),
      'why',
    ),
    "scoped 'prod'",
  );

  console.log('\ninventory shape');
  check('an empty inventory is clean', evaluateInventory({}, { scope: 'prod' }), []);
  check(
    'a package with several resolved versions keeps them all',
    field(
      evaluateInventory(
        { 'MPL-2.0': [{ name: 'lightningcss', versions: ['1.32.0', '1.33.0'] }] },
        { scope: 'prod' },
      ),
      'version',
    ),
    '1.32.0,1.33.0',
  );
  check(
    'and the dev policy allows it',
    evaluateInventory(
      { 'MPL-2.0': [{ name: 'lightningcss', versions: ['1.33.0'] }] },
      { scope: 'dev' },
    ),
    [],
  );

  console.log(`\n${failed === 0 ? 'SELF-TEST PASSED' : `SELF-TEST FAILED (${failed} case(s))`}`);
  return failed ? 1 : 0;
}

// ── Entry point ─────────────────────────────────────────────────────────────────────────

export function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    // The header block: every line after the shebang, up to the first that is not a `//`
    // comment. This used to be a hardcoded `.slice(1, 31)`, which silently started printing
    // the wrong thing the moment anyone added a line to the header — as this commit does.
    const lines = readFileSync(import.meta.filename, 'utf8')
      .split('\n')
      .slice(1);
    const end = lines.findIndex((line) => !line.startsWith('//'));
    const header = lines.slice(0, end === -1 ? lines.length : end);
    console.log(
      header
        .join('\n')
        .replace(/^\/\/ ?/gm, '')
        .trimEnd(),
    );
    return 0;
  }
  if (args.includes('--self-test')) return selfTest();
  const engineAt = args.indexOf('--engine');
  if (engineAt !== -1) {
    const engine = args[engineAt + 1];
    if (engine === undefined || !ENGINE_ID.test(engine)) {
      console.error('usage: check-licenses.mjs --engine <engine id matching ^[a-z][a-z0-9-]*$>');
      return 2;
    }
    return gateMode('prod', engine);
  }
  return gateMode(args.includes('--dev') ? 'dev' : 'prod');
}

// Only exit when run as a program. Importing this module (from a test, or from another script)
// must not terminate the host process — the exported functions above are the API.
const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);
if (invokedDirectly) process.exit(main(process.argv));
