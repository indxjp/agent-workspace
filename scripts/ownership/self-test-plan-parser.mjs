import { requiredValue } from './invariants.mjs';
/* global console */
import { globsIntersect } from './globs.mjs';

import { parsePlan } from './plans.mjs';
/** @param {Pick<import('./types.mjs').SelfTestContext,'check'|'noRoot'>} context */
export function runPlanParserCases({ check, noRoot }) {
  console.log('\nwave-script parsing');

  const script = [
    'export const ownership = {',
    "  Foundation: { 'W1-DB-01': ['migrations/**'] },",
    '  Implement: {',
    "    'W1-RN-01': ['apps/runner/**'],",
    "    'W1-UI-01': ['apps/web/app/**'], // trailing comma and comment tolerated",
    '  },',
    '}',
    "phase('Verify')",
    '// Owns W1-QA-01: packages/core/src/**',
    '// Owns W1-QA-02: packages/gateway/src/**, apps/{web,runner}/e2e/**',
    '// Owns nothing in particular here: this line carries no task id',
  ].join('\n');

  const parsed = parsePlan(script);

  check('levels are discovered', [...parsed.keys()], ['Foundation', 'Implement', 'Verify']);

  check(
    'object-literal globs are read',
    requiredValue(parsed.get('Implement'), 'fixture has Implement phase').get('W1-RN-01'),
    ['apps/runner/**'],
  );

  check(
    'comment globs take the phase as their level',
    requiredValue(parsed.get('Verify'), 'fixture has Verify phase').get('W1-QA-01'),
    ['packages/core/src/**'],
  );

  check(
    'two tasks land at the comment level',
    [...requiredValue(parsed.get('Verify'), 'fixture has Verify phase').keys()],
    ['W1-QA-01', 'W1-QA-02'],
  );

  check(
    'a comment brace list is one glob, not two',
    requiredValue(parsed.get('Verify'), 'fixture has Verify phase').get('W1-QA-02'),
    ['packages/gateway/src/**', 'apps/{web,runner}/e2e/**'],
  );

  const clashing = [
    "export const ownership = { Implement: { 'A': ['packages/core/**'], 'B': ['packages/core/src/db/**'] } }",
  ].join('\n');

  const c = requiredValue(
    parsePlan(clashing).get('Implement'),
    'clashing fixture has Implement phase',
  );

  check('a clashing plan is parsed', [...c.keys()], ['A', 'B']);

  check(
    'and its clash is detected',
    globsIntersect(
      requiredValue(requiredValue(c.get('A'), 'fixture has A')[0], 'fixture A has a glob'),
      requiredValue(requiredValue(c.get('B'), 'fixture has B')[0], 'fixture B has a glob'),
      [],
      noRoot,
    ).intersects,
    true,
  );
}
