import assert from 'node:assert/strict';
import { test } from 'node:test';

import { completed, recipeHarness } from '@indx-workspace/app/testing';

import recipe, { AGENT } from '../../recipes/sla-sweep.ts';

void test('sla-sweep completes, starting one run for its step', async () => {
  const harness = recipeHarness(recipe, { agents: { [AGENT]: [completed('done')] } });

  const run = await harness.start({ slot: '2026-01-01T00:05:00.000Z' });

  assert.equal(run.status, 'completed');
  assert.equal(harness.runsStarted().length, 1);
});
