import console from 'node:console';
import {
  checkParser,
  checkPrecedence,
  checkCanonicalIdentifiers,
  checkDeprecatedForms,
  checkIdentifierCase,
} from './parser.self-test.mjs';
import {
  checkClassification,
  checkDeniedSalvage,
  checkExceptionMatching,
  checkRegisteredIdentifiers,
  checkPolicyInvariants,
  checkDeniedNames,
} from './policy.self-test.mjs';
import {
  checkInventoryGate,
  checkExceptionLifecycle,
  checkInventoryShape,
} from './inventory.self-test.mjs';
import { POLICY } from './policy.mjs';
import { parseSpdx } from './spdx.mjs';
import { makePolicy, classify } from './inventory.mjs';

/**
 * @typedef {object} SelfTestContext
 * @property {(name: string, actual: unknown, expected: unknown) => void} check
 * @property {(name: string, actual: unknown, needle: string) => void} checkContains
 * @property {(rows: ReadonlyArray<import('./types.mjs').InventoryRow>, key: keyof import('./types.mjs').InventoryRow, index?: number) => unknown} field
 * @property {import('./types.mjs').CompiledPolicy} prod
 * @property {import('./types.mjs').CompiledPolicy} dev
 * @property {(licence: string, compiled?: import('./types.mjs').CompiledPolicy) => import('./types.mjs').Classification['verdict']} v
 * @property {(source: string) => boolean} parses
 * @property {import('./types.mjs').ExceptionRegistry} reg
 */

export function selfTest() {
  let failed = 0;
  /** @type {SelfTestContext['check']} */
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok)
      console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  /** @type {SelfTestContext['field']} */
  const field = (rows, key, index = 0) => {
    if (!Array.isArray(rows)) return `<evaluateInventory returned ${typeof rows}, not an array>`;
    if (rows.length <= index)
      return `<no row ${index}: evaluateInventory returned ${rows.length} row(s), so nothing was reported for this package>`;
    const row = rows[index];
    if (row === undefined) throw new Error(`inventory row ${index} is missing`);
    const value = row[key];
    return value === undefined ? `<row ${index} has no \`${key}\` field>` : value;
  };
  // `check` compares with JSON.stringify, which turns every miss on a substring assertion into
  // `expected true, got false` and throws away the string that would explain it. This one keeps
  // it, so a FAIL line is followed by the text that was actually produced.
  /** @type {SelfTestContext['checkContains']} */
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
  /** @type {SelfTestContext['v']} */
  const v = (licence, compiled = prod) => classify(licence, compiled).verdict;
  /** @type {SelfTestContext['parses']} */
  const parses = (s) => {
    try {
      parseSpdx(s);
      return true;
    } catch {
      return false;
    }
  };

  /** @type {import('./types.mjs').ExceptionRegistry} */
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
  const context = { check, checkContains, field, prod, dev, v, parses, reg };
  checkParser(context);
  checkPrecedence(context);
  checkCanonicalIdentifiers(context);
  checkDeprecatedForms(context);
  checkIdentifierCase(context);
  checkClassification(context);
  checkDeniedSalvage(context);
  checkExceptionMatching(context);
  checkRegisteredIdentifiers(context);
  checkPolicyInvariants(context);
  checkDeniedNames(context);
  checkInventoryGate(context);
  checkExceptionLifecycle(context);
  checkInventoryShape(context);
  console.log(`\n${failed === 0 ? 'SELF-TEST PASSED' : `SELF-TEST FAILED (${failed} case(s))`}`);
  return failed ? 1 : 0;
}
