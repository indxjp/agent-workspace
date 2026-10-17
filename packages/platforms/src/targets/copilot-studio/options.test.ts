import { describe, expect, it } from 'vitest';

import { CopilotStudioOptionsSchema } from './options.js';

describe('CopilotStudioOptionsSchema', () => {
  it('requires a publisher prefix and applies the defaults', () => {
    expect(CopilotStudioOptionsSchema.safeParse({}).success).toBe(false);
    expect(CopilotStudioOptionsSchema.parse({ publisherPrefix: 'acme' })).toEqual({
      publisherPrefix: 'acme',
      mcpConnectionMode: 'Maker',
      language: 1033,
    });
  });

  it.each(['A', 'a', 'acme_x', '1acme', 'abcdefghi'])(
    'rejects the prefix %s',
    (publisherPrefix) => {
      expect(CopilotStudioOptionsSchema.safeParse({ publisherPrefix }).success).toBe(false);
    },
  );

  it('rejects an unknown key, a bad connection mode and a bad topic stem', () => {
    const base = { publisherPrefix: 'acme' };
    expect(CopilotStudioOptionsSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(CopilotStudioOptionsSchema.safeParse({ ...base, mcpConnectionMode: 'x' }).success).toBe(
      false,
    );
    expect(
      CopilotStudioOptionsSchema.safeParse({ ...base, topics: { 'Bad Stem': 'kind: X' } }).success,
    ).toBe(false);
    expect(
      CopilotStudioOptionsSchema.safeParse({ ...base, topics: { 'good-stem': 'kind: X' } }).success,
    ).toBe(true);
  });
});
