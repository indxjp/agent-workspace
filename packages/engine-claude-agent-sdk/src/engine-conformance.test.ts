import { expectConformance } from '@agent-workspace/engine/testing';
import { expect, it } from 'vitest';

import { subject } from './engine.test-support.js';

it('reports PASS for every scenario, replaying recorded SDK messages', async () => {
  const verdicts = await expectConformance(subject());
  for (const verdict of verdicts) {
    expect(verdict.pass, `${verdict.scenario}: ${verdict.pass ? '' : verdict.reason}`).toBe(true);
  }
});

import { vi } from 'vitest';

// The real `compileRunRequest` behind a spy, so a test can count the compiles one start performs.
vi.mock('./compile.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./compile.js')>();
  return { ...original, compileRunRequest: vi.fn(original.compileRunRequest) };
});
