#!/usr/bin/env node
// Bare-duration ratchet (refactoring part 03, step 8): a number of 1_000 or more, with or without a
// separator — `60000`, `30_000`, `24 * 60 * 60 * 1_000` — is a duration, a size or a limit,
// and it gets a name: the initializer of a `const` (directly, in arithmetic, or as a value in a
// const table such as a retry policy) or of a class field. Anywhere else it is bare, and the bare
// ones left are counted. The count must equal the ceiling in scripts/duration-ceiling.json; raising
// the ceiling is refused in CI by scripts/duration-ceiling.mjs, so the number can only go down.
//
// The clock ceiling's cheap syntactic measure over its scope (apps/web/server without stores, the
// composition root and tests), plus the runner's and the gateway's source under the same ignores.
//
//   node scripts/check-duration-ceiling.mjs           check the ceiling
//   node scripts/check-duration-ceiling.mjs --list    also print every counted literal
import console from 'node:console';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

import { CLOCK_SCOPE } from './check-clock-ceiling.mjs';
import { DURATION_CEILING_FILE, readDurationCeiling } from './duration-ceiling.mjs';

/** The clock ceiling's scope, plus the runner and the gateway, under the same ignores. */
export const DURATION_SCOPE = {
  files: [...CLOCK_SCOPE.files, 'apps/runner/src/**/*.ts', 'packages/gateway/src/**/*.ts'],
  ignores: CLOCK_SCOPE.ignores,
};

/** The bare durations left in scope; lower it in DURATION_CEILING_FILE when you name some. */
export const DURATION_CEILING = readDurationCeiling();

export const DURATION_MESSAGE =
  'Name this value: make it the initializer of a const that says what it is, such as LEASE_TTL_MS, and use the const (refactoring part 03, step 8).';

/** Nodes a literal may sit in and still be part of its name's initializer. */
const INITIALIZER_PARTS = new Set([
  'BinaryExpression',
  'UnaryExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'ObjectExpression',
  'ArrayExpression',
]);

/**
 * Whether a literal is part of a named value: a `const` declarator's initializer (through
 * arithmetic, `as const`, and object or array values) or a class field's.
 * @param {any} literal
 * @returns {boolean}
 */
export function isNamed(literal) {
  let child = literal;
  let parent = literal.parent;
  while (parent !== undefined && parent !== null) {
    if (parent.type === 'Property' && parent.value === child) {
      child = parent;
      parent = parent.parent;
      continue;
    }
    if (!INITIALIZER_PARTS.has(parent.type)) break;
    child = parent;
    parent = parent.parent;
  }
  if (parent?.type === 'PropertyDefinition') return parent.value === child;
  return (
    parent?.type === 'VariableDeclarator' &&
    parent.init === child &&
    parent.parent?.type === 'VariableDeclaration' &&
    parent.parent.kind === 'const'
  );
}

/**
 * A number of 1_000 or more, written with a separator or not (`60000` is as bare as `60_000`). Not
 * one: a power of ten that multiplies or divides, which is a change of unit (seconds to
 * milliseconds, dollars to micros, rounding to four places); a hexadecimal, octal or binary
 * literal, which is a bit pattern such as a hash seed; a negated literal, because a duration, size
 * or limit is never negative and the negative numbers here are protocol codes (JSON-RPC's -32603);
 * and an argument of `Date.UTC`, which is a calendar field.
 */
export function isDurationLiteral(/** @type {any} */ node) {
  if (typeof node.value !== 'number' || node.value < 1000) return false;
  if (/^0[xob]/iu.test(node.raw)) return false;
  const parent = node.parent;
  if (parent?.type === 'UnaryExpression' && parent.operator === '-') return false;
  if (
    parent?.type === 'CallExpression' &&
    parent.callee?.type === 'MemberExpression' &&
    parent.callee.object?.name === 'Date' &&
    parent.callee.property?.name === 'UTC'
  ) {
    return false;
  }
  const scale = /^10*$/u.test(String(node.value));
  const factor =
    parent?.type === 'BinaryExpression' && (parent.operator === '*' || parent.operator === '/');
  return !(scale && factor);
}

/** @type {import('eslint').Rule.RuleModule} */
const durationRule = {
  meta: { type: 'suggestion', messages: { bare: DURATION_MESSAGE }, schema: [] },
  create(/** @type {any} */ context) {
    return {
      Literal(/** @type {any} */ node) {
        if (isDurationLiteral(node) && !isNamed(node)) context.report({ node, messageId: 'bare' });
      },
    };
  },
};

/** @returns {import('eslint').Linter.Config[]} */
export function durationConfig() {
  return [
    {
      ...DURATION_SCOPE,
      languageOptions: { parser: tseslint.parser },
      plugins: { durations: { rules: { bare: durationRule } } },
      rules: { 'durations/bare': 'error' },
    },
  ];
}

/**
 * @param {number} ceiling DURATION_CEILING
 * @param {number} measured the bare durations counted in scope
 * @returns {string | null} why the ratchet fails, or null when it holds
 */
export function verdict(ceiling, measured) {
  if (measured > ceiling) {
    return `${measured} bare durations in server code, above the ceiling ${ceiling}. ${DURATION_MESSAGE} Run with --list to see them.`;
  }
  if (measured < ceiling) {
    return `the duration ceiling is ${ceiling} but only ${measured} bare durations remain; lower the ceiling in ${DURATION_CEILING_FILE} to ${measured}.`;
  }
  return null;
}

/** @returns {Promise<string[]>} one `file:line` per counted literal */
export async function measure() {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: durationConfig() });
  /** @type {string[]} */
  const literals = [];
  for (const result of await eslint.lintFiles(DURATION_SCOPE.files)) {
    for (const message of result.messages) {
      if (message.fatal === true) throw new Error(`${result.filePath}: ${message.message}`);
      if (message.ruleId !== 'durations/bare') continue;
      literals.push(`${path.relative(process.cwd(), result.filePath)}:${message.line}`);
    }
  }
  return literals;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const literals = await measure();
  if (process.argv.includes('--list')) for (const literal of literals) console.log(literal);
  const failure = verdict(DURATION_CEILING, literals.length);
  if (failure !== null) {
    console.error(failure);
    process.exit(1);
  }
  console.log(
    `duration ceiling ${DURATION_CEILING} equals the bare durations counted in server code.`,
  );
}
