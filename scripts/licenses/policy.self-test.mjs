import console from 'node:console';
import { POLICY, EXCEPTIONS, SPDX_3_28_0_IDENTIFIERS_USED_BY_THIS_POLICY } from './policy.mjs';
import { parseSpdx, expressionDenied } from './spdx.mjs';
import { classify, matchName, matchException, evaluateInventory } from './inventory.mjs';
/** @param {import('./types.mjs').LicensePolicy} policy */
function policyIdentifiers(policy) {
  const out = new Set();
  for (const entries of [
    policy.allow,
    policy.allowDev,
    policy.review,
    policy.denyFamilies,
    policy.denyLiteral,
  ]) {
    for (const entry of entries ?? []) {
      if (entry === 'UNLICENSED') continue;
      for (const token of entry.split(/\s+(?:AND|OR|WITH)\s+/)) out.add(token);
    }
  }
  return [...out];
}

/** @param {Pick<import('./self-test.mjs').SelfTestContext, 'check' | 'dev' | 'v'>} context */
export function checkClassification({ check, dev, v }) {
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
}

/** @param {Pick<import('./self-test.mjs').SelfTestContext, 'check' | 'prod' | 'v'>} context */
export function checkDeniedSalvage({ check, prod, v }) {
  console.log('\nR-16 residual 1 — `GPL-2.0-only WITH <OpenSSL exception>`');
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
}

/** @param {Pick<import('./self-test.mjs').SelfTestContext, 'check' | 'checkContains' | 'field' | 'reg'>} context */
export function checkExceptionMatching({ check, checkContains, field, reg }) {
  console.log('\nR-16 residual 2 — matchException must compare the licence, not just the name');

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
}

/** @param {Pick<import('./self-test.mjs').SelfTestContext, 'check'>} context */
export function checkRegisteredIdentifiers({ check }) {
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
}

/** @param {Pick<import('./self-test.mjs').SelfTestContext, 'check' | 'prod'>} context */
export function checkPolicyInvariants({ check, prod }) {
  console.log('\npolicy invariants');
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
}

/** @param {Pick<import('./self-test.mjs').SelfTestContext, 'check'>} context */
export function checkDeniedNames({ check }) {
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
}
