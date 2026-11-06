import { requiredValue } from './invariants.mjs';
/* global console */

import { findIntegrationViolations } from './body.mjs';

/** @param {Pick<import('./types.mjs').SelfTestContext,'check'|'noRoot'>} context */
export function runIntegrationEnforcementCases({ check, noRoot }) {
  console.log('\nintegration mode — attributing files to the parent that introduced them');

  // The shape of Wave 1a's own integration branch: the integrator wrote three files, and five
  // branches brought in eighty. `parents` is what the commit graph yields; the rule under test is
  // what is done with it.
  const parentsFixture = [
    {
      ref: 'aw/w1-05-run-api',
      globs: ['apps/web/app/api/runs/**', 'docs/adr/README.md'],
      files: ['apps/web/app/api/runs/[id]/route.ts', 'docs/adr/README.md'],
    },
    {
      ref: 'aw/w1-06-agent-crud',
      globs: ['apps/web/app/api/agents/**', 'docs/adr/README.md'],
      files: ['apps/web/app/api/agents/route.ts', 'docs/adr/README.md'],
    },
  ];

  /** @param {string[]} files */
  const iv = (files) =>
    findIntegrationViolations(
      ['docs/integration/W1a-manifest.md'],
      parentsFixture,
      files,
      noRoot,
    ).map((x) => x.file);

  check(
    'a file the integrator wrote is accounted for by its own globs',
    iv(['docs/integration/W1a-manifest.md']),
    [],
  );

  check(
    'a merged branch’s file is accounted for by that branch’s globs',
    iv(['apps/web/app/api/runs/[id]/route.ts', 'apps/web/app/api/agents/route.ts']),
    [],
  );

  check(
    'a generated file introduced by two parents needs only one of them to vouch',
    iv(['docs/adr/README.md']),
    [],
  );

  check(
    'a file no parent introduced and the integrator did not declare FAILS',
    iv(['apps/web/instrumentation.ts']),
    ['apps/web/instrumentation.ts'],
  );

  check(
    'a file its own parent did not declare FAILS, even though the merge carried it',
    findIntegrationViolations(
      ['docs/integration/W1a-manifest.md'],
      [{ ref: 'aw/x', globs: ['apps/web/app/api/runs/**'], files: ['packages/core/src/db.ts'] }],
      ['packages/core/src/db.ts'],
      noRoot,
    ).map((x) => x.file),
    ['packages/core/src/db.ts'],
  );

  check(
    'the two failures are told apart, because they call for different repairs',
    requiredValue(
      findIntegrationViolations(
        ['docs/integration/W1a-manifest.md'],
        parentsFixture,
        ['apps/web/instrumentation.ts'],
        noRoot,
      )[0],
      'fixture produces one violation',
    ).why.includes('no merged parent introduced it'),
    true,
  );

  check(
    'an empty declaration vouches for nothing — the reach guard is not the only guard',
    findIntegrationViolations(
      [],
      [{ ref: 'aw/x', globs: [], files: ['apps/web/app/api/runs/[id]/route.ts'] }],
      ['apps/web/app/api/runs/[id]/route.ts'],
      noRoot,
    ).map((x) => x.file),
    ['apps/web/app/api/runs/[id]/route.ts'],
  );
}
