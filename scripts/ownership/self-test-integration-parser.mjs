import { requiredValue } from './invariants.mjs';
/* global console */

import { parseIntegrationOwnership } from './body.mjs';

/** @param {Pick<import('./types.mjs').SelfTestContext,'check'>} context */
export function runIntegrationParserCases({ check }) {
  console.log('\nintegration mode — parsing an integration PR body');

  const integrationBody = [
    '## Ownership',
    'Owns globs: `docs/integration/W1a-manifest.md`, `docs/adr/W1a-INT-*.md`',
    '- Merged `aw/w1-05-run-api`: `apps/web/app/api/runs/**`, `apps/web/server/runs/**`',
    '- **Merged aw/w1-06-agent-crud**: apps/web/app/api/agents/**, apps/web/server/agents/**',
    '',
    '## Declared gaps',
    'Owns globs: this line is in another section and must not be read',
  ].join('\n');

  const integ = parseIntegrationOwnership(integrationBody);

  check('the integrator’s own globs are read', integ.ok && integ.globs, [
    'docs/integration/W1a-manifest.md',
    'docs/adr/W1a-INT-*.md',
  ]);

  check(
    'one entry per merged branch, refs unquoted and emphasis stripped',
    integ.ok && integ.merged.map((m) => m.ref),
    ['aw/w1-05-run-api', 'aw/w1-06-agent-crud'],
  );

  check(
    'a merged branch’s globs are read',
    integ.ok && requiredValue(integ.merged[1], 'fixture has two merged branches').globs,
    ['apps/web/app/api/agents/**', 'apps/web/server/agents/**'],
  );

  check(
    'an integration body with no Merged line is refused',
    parseIntegrationOwnership('## Ownership\nOwns globs: `docs/**`\n').ok,
    false,
  );

  check(
    'a Merged line that claims the repository is refused, like any other declaration',
    parseIntegrationOwnership('## Ownership\nOwns globs: `docs/adr/**`\nMerged aw/x: `**`\n').ok,
    false,
  );
}
