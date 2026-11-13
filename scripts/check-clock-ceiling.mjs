#!/usr/bin/env node
// Clock and random-id ratchet (refactoring plan §07, "clock and random-id calls in domain code
// outside adapters"): server code takes the time from a `Clock` (apps/web/server/clock.ts) and ids
// from an `IdGenerator` (apps/web/server/ids.ts). The direct calls that remain are counted, and the
// count must equal the ceiling in scripts/clock-ceiling.json: a new call fails, and so does a
// ceiling left above the code after calls are removed. Raising the ceiling instead is refused in
// CI by scripts/clock-ceiling.mjs, which compares it with the base, so the number can only go down.
//
// The same shape as scripts/check-complexity-ceiling.mjs: measured syntactically (no type
// information, so it is cheap) over the scope the plan counts — apps/web/server without stores,
// the composition root, tests, test helpers and the two adapters.
//
//   node scripts/check-clock-ceiling.mjs           check the ceiling
//   node scripts/check-clock-ceiling.mjs --list    also print every counted call
import console from 'node:console';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

import { CEILING_FILE, readCeiling } from './clock-ceiling.mjs';

/** The direct clock and random-id calls left in scope; lower it in CEILING_FILE when you remove some. */
export const CLOCK_CALLS_CEILING = readCeiling();

export const CLOCK_MESSAGE =
  'Take the time from a Clock (apps/web/server/clock.ts) and ids from an IdGenerator (apps/web/server/ids.ts), passed in, instead of reading them here (refactoring plan §07).';

/**
 * Reading the clock or minting a random id directly. `Date.now` and `Math.random` count as
 * references too (passing one as a default reads the clock just the same); `new Date(value)`
 * parses a value and is not counted. A renamed import is counted by {@link aliasedRandomIdRule}.
 *
 * Not counted, on purpose: `crypto.getRandomValues` and `randomInt`. In server code they only make
 * secret material (a one-time HMAC comparison key, API key and invitation secrets, CLI user codes),
 * which stays a CSPRNG call where it is used: an injectable generator would let a secret be made
 * predictable, and tests check a secret's shape, never its value.
 */
export const CLOCK_SELECTORS = [
  "MemberExpression[object.name='Date'][property.name='now']",
  "NewExpression[callee.name='Date'][arguments.length=0]",
  "MemberExpression[object.name='Math'][property.name='random']",
  'CallExpression[callee.name=/^(randomUUID|randomBytes)$/]',
  'MemberExpression[property.name=/^(randomUUID|randomBytes)$/]',
];

/** The random-id functions `node:crypto` exports, counted under whatever local name they are imported. */
const RANDOM_ID_EXPORTS = new Set(['randomUUID', 'randomBytes']);

/**
 * `import { randomUUID as mint } from 'node:crypto'` and then `mint()`: the selectors above match
 * the imported name, so a renamed import would pass uncounted. This rule reports each use of the
 * local name instead.
 * @type {import('eslint').Rule.RuleModule}
 */
const aliasedRandomIdRule = {
  meta: { type: 'suggestion', messages: { aliased: CLOCK_MESSAGE }, schema: [] },
  create(/** @type {any} */ context) {
    return {
      ImportSpecifier(/** @type {any} */ node) {
        const imported = node.imported?.name ?? node.imported?.value;
        if (!RANDOM_ID_EXPORTS.has(imported) || node.local.name === imported) return;
        for (const variable of context.sourceCode.getDeclaredVariables(node)) {
          for (const reference of variable.references) {
            context.report({ node: reference.identifier, messageId: 'aliased' });
          }
        }
      },
    };
  },
};

/** The plan's count: server code minus stores, composition, tests, test helpers and the adapters. */
export const CLOCK_SCOPE = {
  files: ['apps/web/server/**/*.ts'],
  ignores: [
    '**/*.test.ts',
    '**/*.spec.ts',
    '**/*.acceptance.ts',
    '**/acceptance/**',
    '**/*.test-support.ts',
    '**/testing/**',
    '**/testing.ts',
    '**/test-helpers/**',
    '**/test-helper*.ts',
    '**/e2e/**',
    '**/*fixture.ts',
    '**/*fixtures.ts',
    '**/*.contract.ts',
    '**/*.conformance.ts',
    '**/memory.ts',
    '**/memory-*.ts',
    // Stores by the names they have here; a plain `*store*` would also hide `restore-*.ts`.
    '**/store.ts',
    '**/store.*.ts',
    '**/store-*.ts',
    '**/*-store.ts',
    '**/store/**',
    '**/*-store/**',
    'apps/web/server/composition/**',
    'apps/web/server/clock.ts',
    'apps/web/server/ids.ts',
  ],
};

/** @returns {import('eslint').Linter.Config[]} */
export function clockConfig() {
  return [
    {
      ...CLOCK_SCOPE,
      languageOptions: { parser: tseslint.parser },
      plugins: { clock: { rules: { 'aliased-random-id': aliasedRandomIdRule } } },
      rules: {
        'no-restricted-syntax': [
          'error',
          ...CLOCK_SELECTORS.map((selector) => ({ selector, message: CLOCK_MESSAGE })),
        ],
        'clock/aliased-random-id': 'error',
      },
    },
  ];
}

/**
 * @param {number} ceiling CLOCK_CALLS_CEILING
 * @param {number} measured the direct calls counted in scope
 * @returns {string | null} why the ratchet fails, or null when it holds
 */
export function verdict(ceiling, measured) {
  if (measured > ceiling) {
    return `${measured} direct clock or random-id calls in server code, above the ceiling ${ceiling}. ${CLOCK_MESSAGE} Run with --list to see them.`;
  }
  if (measured < ceiling) {
    return `the clock ceiling is ${ceiling} but only ${measured} calls remain; lower the ceiling in ${CEILING_FILE} to ${measured}.`;
  }
  return null;
}

/** @returns {Promise<string[]>} one `file:line` per counted call */
export async function measure() {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: clockConfig() });
  /** @type {string[]} */
  const calls = [];
  for (const result of await eslint.lintFiles(CLOCK_SCOPE.files)) {
    for (const message of result.messages) {
      if (message.fatal === true) throw new Error(`${result.filePath}: ${message.message}`);
      if (
        message.ruleId !== 'no-restricted-syntax' &&
        message.ruleId !== 'clock/aliased-random-id'
      ) {
        continue;
      }
      calls.push(`${path.relative(process.cwd(), result.filePath)}:${message.line}`);
    }
  }
  return calls;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const calls = await measure();
  if (process.argv.includes('--list')) for (const call of calls) console.log(call);
  const failure = verdict(CLOCK_CALLS_CEILING, calls.length);
  if (failure !== null) {
    console.error(failure);
    process.exit(1);
  }
  console.log(
    `clock ceiling ${CLOCK_CALLS_CEILING} equals the direct calls counted in server code.`,
  );
}
