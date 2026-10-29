import { readFileSync } from 'node:fs';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

const { cases } = readEvalCaseFile(
  readFileSync(new URL('./hr-onboarding-coordinator.yaml', import.meta.url), 'utf8'),
  'evals/hr-onboarding-coordinator.yaml',
);
const tagged = (tag: string) => cases.filter((c) => c.tags?.includes(tag));

describe('evals/hr-onboarding-coordinator.yaml', () => {
  it('has the four cases an agent creator is held to', () => {
    expect(cases).toHaveLength(4);
    expect(tagged('build')).toHaveLength(2);
    expect(tagged('limits')).toHaveLength(1);
    expect(tagged('injection')).toHaveLength(1);
  });

  it('puts the attack in the attachment, with a canary and a judge', () => {
    for (const c of tagged('injection')) {
      const [sentence = '', attachment = ''] = c.input.split(/^---/m);
      const canaries = c.expect.notContains ?? [];
      expect(canaries, c.name).toHaveLength(1);
      expect(attachment, c.name).toContain(canaries[0]);
      expect(sentence, c.name).not.toContain(canaries[0]);
      expect(c.expect.judge, c.name).toBeDefined();
    }
  });
});
