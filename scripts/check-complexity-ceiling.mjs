#!/usr/bin/env node
// Complexity ratchet (F-15): the `complexity` ceiling in eslint.config.mjs equals the measured
// maximum of the production code it covers.
//
// ESLint already fails a function above the ceiling. What it cannot see is the ceiling left above
// the code after a hotspot is simplified, which leaves room for the next function to grow into.
// This measures every function the real config holds to a ceiling, syntactically (no type
// information, so it is cheap), and fails unless the highest complexity equals the ceiling.
//
//   node scripts/check-complexity-ceiling.mjs
import console from 'node:console';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

/**
 * @param {number} ceiling the configured `complexity` maximum
 * @param {number} measured the highest complexity of any covered function
 * @returns {string | null} why the ratchet fails, or null when it holds
 */
export function verdict(ceiling, measured) {
  if (measured > ceiling) {
    return `a function has complexity ${measured}, above the ceiling ${ceiling}; simplify it (pnpm lint names it).`;
  }
  if (measured < ceiling) {
    return `the complexity ceiling is ${ceiling} but the highest measured is ${measured}; lower complexity.max in eslint.config.mjs to ${measured}.`;
  }
  return null;
}

/**
 * The configured ceiling of `file`, or null when the real config does not hold it to one.
 * @param {ESLint} configured
 * @param {string} file
 * @returns {Promise<number | null>}
 */
async function ceilingOf(configured, file) {
  /** @type {{ rules?: Record<string, unknown> } | undefined} */
  const config = await configured.calculateConfigForFile(file);
  const rule = config?.rules?.['complexity'];
  if (!Array.isArray(rule) || rule[0] === 0 || rule[0] === 'off') return null;
  /** @type {unknown} */
  const option = rule[1];
  if (typeof option === 'object' && option !== null && 'max' in option) {
    return typeof option.max === 'number' ? option.max : null;
  }
  return typeof option === 'number' ? option : null;
}

/** @returns {Promise<{ ceiling: number; measured: number; where: string }>} */
async function measure() {
  const configured = new ESLint();
  // Every function is reported with its complexity; the real config then says which files count.
  const measuring = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.next-embedded/**'] },
      {
        files: ['**/*.{ts,tsx}'],
        languageOptions: { parser: tseslint.parser },
        rules: { complexity: ['error', { max: 0 }] },
      },
    ],
  });
  /** @type {Set<number>} */
  const ceilings = new Set();
  let measured = 0;
  let where = '';
  for (const result of await measuring.lintFiles([
    'apps/**/*.{ts,tsx}',
    'packages/**/*.{ts,tsx}',
  ])) {
    const ceiling = await ceilingOf(configured, result.filePath);
    if (ceiling === null) continue;
    ceilings.add(ceiling);
    for (const message of result.messages) {
      if (message.fatal === true) throw new Error(`${result.filePath}: ${message.message}`);
      const complexity = Number(/complexity of (\d+)/u.exec(message.message)?.[1] ?? 0);
      if (complexity > measured) {
        measured = complexity;
        where = `${result.filePath}:${message.line}`;
      }
    }
  }
  if (ceilings.size !== 1) {
    throw new Error(`expected one complexity ceiling, found ${[...ceilings].join(', ') || 'none'}`);
  }
  return { ceiling: [...ceilings][0] ?? 0, measured, where };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ceiling, measured, where } = await measure();
  const failure = verdict(ceiling, measured);
  if (failure !== null) {
    console.error(failure);
    process.exit(1);
  }
  console.log(`complexity ceiling ${ceiling} equals the measured maximum (${where}).`);
}
