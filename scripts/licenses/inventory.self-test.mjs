import console from 'node:console';
import { evaluateInventory } from './inventory.mjs';
/** @param {Pick<import('./self-test.mjs').SelfTestContext, 'check'>} context */
export function checkInventoryGate({ check }) {
  console.log('\nend to end — the W0-INF-03 acceptance criterion (plan §6.2)');
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
}

/** @param {Pick<import('./self-test.mjs').SelfTestContext, 'check' | 'checkContains' | 'field' | 'reg'>} context */
export function checkExceptionLifecycle({ check, checkContains, field, reg }) {
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
  const noExpiryTree = {
    'LGPL-3.0-or-later': [{ name: '@img/sharp-libvips-linux-x64', versions: ['1.3.3'] }],
  };
  /** @param {unknown} expires @returns {import('./types.mjs').ExceptionRegistry} */
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
        { exceptions: reg, scope: 'dev', now: beforeExpiry },
      ),
      'why',
    ),
    "scoped 'prod'",
  );
}

/** @param {Pick<import('./self-test.mjs').SelfTestContext, 'check' | 'field'>} context */
export function checkInventoryShape({ check, field }) {
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
}
