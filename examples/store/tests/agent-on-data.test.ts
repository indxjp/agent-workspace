import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * The store's Agent on data cell is a declared gap (benchmark.ts): the store keeps no data of its
 * own, so there is no resource for an agent to act on as a person. This test is what keeps that
 * statement true: it fails when `app.config.ts` declares a resource or a recipe, and the gap must
 * then become a real Agent on data test.
 */
test('the store keeps no data of its own, so no agent acts on any', () => {
  const config = readFileSync(new URL('../app.config.ts', import.meta.url), 'utf8');
  assert.match(config, /resources:\s*\[\s*\]/u);
  assert.match(config, /recipes:\s*\[\s*\]/u);
});
