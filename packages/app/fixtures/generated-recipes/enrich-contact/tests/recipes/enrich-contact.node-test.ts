import assert from 'node:assert/strict';
import { test } from 'node:test';

import { completed, recipeHarness } from '@indx-workspace/app/testing';

import recipe, { AGENT } from '../../recipes/enrich-contact.ts';

void test('enrich-contact completes, starting one run for its step', async () => {
  const harness = recipeHarness(recipe, { agents: { [AGENT]: [completed('done')] } });

  const run = await harness.start({
    resource: 'contact',
    event: 'created',
    record: { id: '00000000-0000-4000-8000-000000000001' },
  });

  assert.equal(run.status, 'completed');
  assert.equal(harness.runsStarted().length, 1);
});
