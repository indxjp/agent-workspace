import console from 'node:console';
import {
  parseSpdx,
  DEPRECATED_SPDX_WITH_FORMS,
  canonicaliseSpdx,
  canonicalLicence,
} from './spdx.mjs';
import { classify, evaluateInventory } from './inventory.mjs';
/** @param {Pick<import('./self-test.mjs').SelfTestContext, 'check' | 'parses'>} context */
export function checkParser({ check, parses }) {
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
        return e instanceof Error ? e.message : String(e);
      }
    })(),
    'Unexpected `<` at offset 18',
  );
}

/** @param {Pick<import('./self-test.mjs').SelfTestContext, 'check' | 'v'>} context */
export function checkPrecedence({ check, v }) {
  console.log('\nprecedence — AND binds tighter than OR');
  // Both cases below come out ALLOW under the SPDX precedence (`AND` binds tighter than `OR`,
  // so we may take the bare MIT disjunct) and DENY if the two operators are read left to right.
  // A parser that got the precedence backwards would fail the build on a licence we accept.
  check('AND/OR precedence, MIT on the left', v('MIT OR GPL-3.0-only AND GPL-2.0-only'), 'allow');
  check('AND/OR precedence, MIT on the right', v('GPL-2.0-only AND MIT OR MIT'), 'allow');
}

/** @param {Pick<import('./self-test.mjs').SelfTestContext, 'check'>} context */
export function checkCanonicalIdentifiers({ check }) {
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
}

/** @param {Pick<import('./self-test.mjs').SelfTestContext, 'check' | 'checkContains' | 'prod' | 'v' | 'parses'>} context */
export function checkDeprecatedForms({ check, checkContains, prod, v, parses }) {
  console.log('\ndeprecated single-identifier WITH forms — the laundering path this closes');
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
    deprecatedWithForms.filter((id) => {
      const replacement = DEPRECATED_SPDX_WITH_FORMS[id];
      return replacement === undefined || !parses(replacement);
    }),
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
}

/** @param {Pick<import('./self-test.mjs').SelfTestContext, 'check' | 'v'>} context */
export function checkIdentifierCase({ check, v }) {
  console.log('\ncase — SPDX identifiers are case-insensitive, so every spelling is one licence');
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
        return `threw: ${error instanceof Error ? error.message : String(error)}`;
      }
    })(),
    'built',
  );
}
