import { beforeEach, describe, expect, it } from 'vitest';

import { parsePublishShareRequest } from './input';

describe('publish share request', () => {
  const valid = {
    subjectType: 'session',
    subjectId: 'session-one',
    subjectLabel: 'Session one',
    visibility: 'workspace',
  } as const;

  it('accepts the minimal explicit contract', () => {
    expect(parsePublishShareRequest(valid)).toEqual(valid);
  });

  it.each([
    ['unknown fields', { ...valid, typo: true }],
    ['unknown subjects', { ...valid, subjectType: 'run' }],
    ['negative budgets', { ...valid, budgetCapUsd: -1 }],
    ['non-boolean include flags', { ...valid, include: { outputFiles: 'yes' } }],
    ['unknown include flags', { ...valid, include: { privateNotes: true } }],
    ['malformed definitions', { ...valid, definition: { name: 'Agent' } }],
    [
      'agent definitions on sessions',
      { ...valid, definition: { name: 'Agent', instructions: '' } },
    ],
    ['session transcripts on agents', { ...valid, subjectType: 'agent', transcript: [] }],
    [
      'budgets on definition shares',
      { ...valid, subjectType: 'agent', mode: 'definition', budgetCapUsd: 20 },
    ],
  ])('rejects %s', (_label, value) => {
    expect(() => parsePublishShareRequest(value)).toThrow();
  });

  describe('caller-authored subject labels', () => {
    let parsed: ReturnType<typeof parsePublishShareRequest>;

    beforeEach(() => {
      parsed = parsePublishShareRequest(valid);
    });

    it('RF-103 parses the valid publish request used by the characterization', () => {
      expect(parsed).toMatchObject({
        subjectType: valid.subjectType,
        subjectId: valid.subjectId,
        subjectLabel: valid.subjectLabel,
        visibility: valid.visibility,
      });
    });

    it.fails(
      'RF-103 omits caller-authored subjectLabel from parsed publish input (expected failure until RF-103)',
      () => {
        expect(parsed).not.toHaveProperty('subjectLabel');
      },
    );
  });

  const authoritativeContentCases: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ['snapshot', { ...valid, snapshot: { messages: [] } }, { messages: [] }],
    ['transcript', { ...valid, transcript: [] }, []],
    [
      'definition',
      {
        ...valid,
        subjectType: 'agent',
        definition: { name: 'Support', instructions: 'Answer accurately.' },
      },
      { name: 'Support', instructions: 'Answer accurately.' },
    ],
  ];

  for (const [field, value, expected] of authoritativeContentCases) {
    it(`RF-103 currently preserves caller-authored ${field} in parsed publish input`, () => {
      expect(parsePublishShareRequest(value)).toHaveProperty(field, expected);
    });

    it.fails(`RF-103 rejects caller-authored ${field} (expected failure until RF-103)`, () => {
      expect(() => parsePublishShareRequest(value)).toThrow();
    });
  }
});
