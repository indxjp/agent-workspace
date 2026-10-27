import { readFileSync } from 'node:fs';

import { readEvalCaseFile } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

const { cases } = readEvalCaseFile(
  readFileSync(new URL('./builder.yaml', import.meta.url), 'utf8'),
  'evals/builder.yaml',
);
const tagged = (tag: string) => cases.filter((c) => c.tags?.includes(tag));

describe('evals/builder.yaml', () => {
  it('has the case counts the Builder gate needs', () => {
    expect(cases.length).toBeGreaterThanOrEqual(24);
    expect(tagged('build').length).toBeGreaterThanOrEqual(10);
    expect(tagged('ask').length).toBeGreaterThanOrEqual(6);
    expect(tagged('injection').length).toBeGreaterThanOrEqual(8);
  });

  it('puts every attack in the attachment, with a canary and a judge', () => {
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
